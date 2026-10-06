# SPDX-License-Identifier: MIT
"""LLDB's Python API over a private, line-delimited stdio channel."""

import json
import os
import queue
import sys
import threading

protocol_input, protocol_output, protocol_error = sys.stdin, sys.stdout, sys.stderr
import lldb


def emit(message):
    protocol_output.write(json.dumps(message) + "\n")
    protocol_output.flush()


def trace(message):
    protocol_error.write(message + "\n")
    protocol_error.flush()
    emit({"event": "progress", "text": message})


def check(error):
    if error.Fail():
        raise RuntimeError(error.GetCString() or "LLDB operation failed")


class Worker:
    def __init__(self):
        self.debugger = lldb.SBDebugger.Create()
        self.debugger.SetAsync(True)
        self.listener = self.debugger.GetListener()
        self.target = None
        self.process = None
        self.stop_id = 0
        self.values = {}
        self.next_value = 0
        self.breakpoints = set()
        self.launched = False

    def thread(self, thread_id=None):
        thread = (self.process.GetThreadByID(int(thread_id)) if thread_id
                  else self.process.GetSelectedThread())
        if not thread.IsValid():
            raise RuntimeError("Native thread is unavailable")
        return thread

    def frame(self, params):
        if self.process.GetState() != lldb.eStateStopped:
            raise RuntimeError("The native app is not paused")
        frame = self.thread(params.get("thread")).GetFrameAtIndex(int(params.get("frame", 0)))
        if not frame.IsValid():
            raise RuntimeError("Native frame is unavailable")
        return frame

    def value(self, value):
        result = {"name": value.GetName() or "", "type": value.GetTypeName() or "native",
                  "value": value.GetValue(), "summary": value.GetSummary()}
        if value.MightHaveChildren():
            self.next_value += 1
            self.values[self.next_value] = value
            result["handle"] = self.next_value
        return result

    def stack(self, thread):
        frames = []
        for level in range(min(thread.GetNumFrames(), 40)):
            frame = thread.GetFrameAtIndex(level)
            entry = frame.GetLineEntry()
            frames.append({"level": level, "function": frame.GetFunctionName() or "(native)",
                           "file": str(entry.GetFileSpec()) if entry.IsValid() else "",
                           "line": entry.GetLine() if entry.IsValid() else 0,
                           "column": entry.GetColumn() if entry.IsValid() else 0})
        return frames

    def sources(self):
        files = {}
        for module in self.target.module_iter():
            # Publish the executable's DWARF files, not all system frameworks.
            if module.GetFileSpec() != self.target.GetExecutable():
                continue
            for index in range(module.GetNumCompileUnits()):
                unit = module.GetCompileUnitAtIndex(index)
                for line_index in range(unit.GetNumLineEntries()):
                    entry = unit.GetLineEntryAtIndex(line_index)
                    filename = str(entry.GetFileSpec())
                    if entry.GetLine() > 0 and os.path.isfile(filename):
                        files.setdefault(os.path.realpath(filename), set()).add(entry.GetLine())
        return [{"file": file, "lines": sorted(lines)} for file, lines in sorted(files.items())]

    def handle(self, method, params):
        if method in ("attach", "launch"):
            trace("Creating native target")
            self.debugger.SetAsync(False)
            error = lldb.SBError()
            self.target = self.debugger.CreateTarget(
                params.get("executable", ""), None, params.get("platform"), False, error)
            check(error)
            if not self.target.IsValid():
                raise RuntimeError("Cannot load the native executable")
            if params.get("sdkRoot"):
                self.target.GetPlatform().SetSDKRoot(params["sdkRoot"])
            trace("Attaching to process" if method == "attach" else "Launching native process")
            if method == "attach":
                self.process = self.target.AttachToProcessWithID(self.listener, int(params["pid"]), error)
            else:
                self.launched = True
                launch = lldb.SBLaunchInfo(params.get("args", []))
                launch.SetEnvironmentEntries(
                    [key + "=" + value for key, value in params.get("env", {}).items()], True)
                launch.SetWorkingDirectory(params.get("cwd", os.getcwd()))
                launch.SetLaunchFlags(launch.GetLaunchFlags() | lldb.eLaunchFlagStopAtEntry)
                launch.SetListener(self.listener)
                self.process = self.target.Launch(launch, error)
            check(error)
            trace("Reading native debug symbols")
            self.stop_id = self.process.GetStopID()
            sources = self.sources()
            self.debugger.SetAsync(True)
            trace("Resuming native process")
            check(self.process.Continue())
            return {"sources": sources, "pid": self.process.GetProcessID()}
        if method == "breakpoint":
            breakpoint = self.target.BreakpointCreateByLocation(params["file"], int(params["line"]))
            if not breakpoint.IsValid() or breakpoint.GetNumLocations() == 0:
                if breakpoint.IsValid():
                    self.target.BreakpointDelete(breakpoint.GetID())
                raise RuntimeError("No executable code at this native source position")
            self.breakpoints.add(breakpoint.GetID())
            breakpoint.SetEnabled(params.get("enabled", True))
            if params.get("temporary"):
                breakpoint.SetOneShot(True)
            if params.get("condition"):
                breakpoint.SetCondition(params["condition"])
            entry = breakpoint.GetLocationAtIndex(0).GetAddress().GetLineEntry()
            return {"id": breakpoint.GetID(), "line": entry.GetLine(),
                    "file": str(entry.GetFileSpec())}
        if method == "locations":
            addresses = params.get("addresses", [])
            if len(addresses) > 128:
                raise RuntimeError("Native handler location limit exceeded")
            locations = {}
            def readable(entry):
                return (entry.IsValid() and entry.GetLine() > 0
                        and os.path.isfile(str(entry.GetFileSpec())))
            for value in addresses:
                raw = int(value, 16)
                if hasattr(self.process, "FixAddress"):
                    raw = self.process.FixAddress(raw, lldb.eAddressMaskTypeCode)
                address = self.target.ResolveLoadAddress(raw)
                entry = address.GetLineEntry()
                # Objective-C entry thunks may carry no line entry. Their
                # enclosing function can still have a source declaration.
                if not readable(entry):
                    function = address.GetFunction()
                    if function.IsValid():
                        entry = function.GetStartAddress().GetLineEntry()
                if not readable(entry):
                    symbol = address.GetSymbol()
                    mangled = symbol.GetMangledName() if symbol.IsValid() else ""
                    # Swift's stable ABI appends 'To' for Swift-as-ObjC thunks:
                    # https://github.com/swiftlang/swift/blob/main/docs/ABI/Mangling.rst
                    # Resolve the exact implementation in the same module;
                    # demangled name searches omit Swift in some LLDB versions.
                    if mangled and mangled.startswith(("$s", "$S")) and mangled.endswith("To"):
                        candidate = address.GetModule().FindSymbol(mangled[:-2], lldb.eSymbolTypeCode)
                        if candidate.IsValid():
                            entry = candidate.GetStartAddress().GetLineEntry()
                if readable(entry):
                    locations[value] = {"file": str(entry.GetFileSpec()),
                                        "line": entry.GetLine(), "column": entry.GetColumn()}
            return {"locations": locations}
        if method == "remove":
            self.target.BreakpointDelete(int(params["id"]))
            self.breakpoints.discard(int(params["id"]))
            return {}
        if method == "active":
            for breakpoint_id in self.breakpoints:
                self.target.FindBreakpointByID(breakpoint_id).SetEnabled(params["active"])
            return {}
        if method == "pause":
            check(self.process.Stop())
            return {}
        if method == "resume":
            check(self.process.Continue())
            return {}
        if method == "step":
            thread = self.thread(params.get("thread"))
            self.process.SetSelectedThread(thread)
            if params["mode"] == "into":
                thread.StepInto(lldb.eOnlyDuringStepping)
            elif params["mode"] == "out":
                thread.StepOut()
            else:
                thread.StepOver(lldb.eOnlyDuringStepping)
            return {}
        if method == "variables":
            variables = self.frame(params).GetVariables(True, True, False, True)
            return {"values": [self.value(value) for value in variables]}
        if method == "children":
            value = self.values.get(int(params["handle"]))
            if value is None:
                raise RuntimeError("Stale native value")
            return {"values": [self.value(value.GetChildAtIndex(i))
                               for i in range(min(value.GetNumChildren(), 128))]}
        if method == "evaluate":
            options = lldb.SBExpressionOptions()
            options.SetTimeoutInMicroSeconds(1000000)
            options.SetIgnoreBreakpoints(True)
            options.SetTryAllThreads(False)
            value = self.frame(params).EvaluateExpression(params["expression"], options)
            check(value.GetError())
            return self.value(value)
        if method == "close":
            self.close(params.get("terminate", False))
            return {}
        raise RuntimeError("Unknown LLDB operation: " + method)

    def events(self):
        event = lldb.SBEvent()
        while self.listener.GetNextEvent(event):
            if not lldb.SBProcess.EventIsProcessEvent(event):
                continue
            state = lldb.SBProcess.GetStateFromEvent(event)
            if state == lldb.eStateRunning:
                emit({"event": "running"})
            elif state == lldb.eStateStopped and not lldb.SBProcess.GetRestartedFromEvent(event):
                stop_id = self.process.GetStopID()
                if stop_id <= self.stop_id:
                    continue
                self.stop_id = stop_id
                self.values.clear()
                thread = self.process.GetSelectedThread()
                for candidate in self.process:
                    if candidate.GetStopReason() in (lldb.eStopReasonBreakpoint, lldb.eStopReasonPlanComplete):
                        thread = candidate
                        break
                self.process.SetSelectedThread(thread)
                reason = thread.GetStopReason()
                hit = [thread.GetStopReasonDataAtIndex(i)
                       for i in range(0, thread.GetStopReasonDataCount(), 2)] if reason == lldb.eStopReasonBreakpoint else []
                emit({"event": "stopped", "thread": str(thread.GetThreadID()),
                      "reason": "breakpoint" if hit else "step" if reason == lldb.eStopReasonPlanComplete else "pause",
                      "description": thread.GetStopDescription(256),
                      "breakpoints": hit, "frames": self.stack(thread)})
            elif state in (lldb.eStateExited, lldb.eStateDetached):
                emit({"event": "exited"})
            if self.process:
                for getter in (self.process.GetSTDOUT, self.process.GetSTDERR):
                    output = getter(4096)
                    if output:
                        emit({"event": "output", "text": output})

    def close(self, terminate=False):
        if not self.debugger:
            return
        if self.process and self.process.IsValid():
            for breakpoint_id in self.breakpoints:
                self.target.BreakpointDelete(breakpoint_id)
            self.breakpoints.clear()
            if self.process.GetState() not in (lldb.eStateExited, lldb.eStateDetached):
                if terminate and self.launched:
                    self.process.Kill()
                else:
                    self.process.Detach()
        if self.debugger:
            lldb.SBDebugger.Destroy(self.debugger)
            self.debugger = None


def main():
    requests = queue.Queue()

    def read():
        for line in protocol_input:
            requests.put(line)
        requests.put(None)

    trace("Initializing LLDB")
    worker = Worker()
    trace("LLDB ready")
    threading.Thread(target=read, daemon=True).start()
    emit({"event": "ready"})
    try:
        while True:
            worker.events()
            try:
                line = requests.get(timeout=0.02)
            except queue.Empty:
                continue
            if line is None:
                break
            request = {}
            try:
                request = json.loads(line)
                result = worker.handle(request["method"], request.get("params", {}))
                emit({"id": request["id"], "result": result})
                if request["method"] == "close":
                    break
            except Exception as error:
                emit({"id": request.get("id"), "error": str(error)})
    finally:
        worker.close()


if __name__ == "__main__":
    main()
