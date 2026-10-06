// SPDX-License-Identifier: MIT
import AppKit
import ApplicationServices

enum BridgeError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    if case .message(let text) = self { return text }
    return nil
  }
}
final class Border: NSView {
  override func draw(_ dirtyRect: NSRect) {
    NSColor.systemBlue.withAlphaComponent(0.12).setFill()
    bounds.fill()
    NSColor.systemBlue.setStroke()
    let path = NSBezierPath(rect: bounds.insetBy(dx: 1, dy: 1))
    path.lineWidth = 2
    path.stroke()
  }
}
// A temporary input surface captures picks in the target window only. No global
// event tap runs AX calls on the operating system's input delivery path.
final class PickerPanel: NSPanel {
  override var canBecomeKey: Bool { true }
}
final class PickerSurface: NSView {
  var point: ((NSEvent, Bool) -> Void)?
  var released: (() -> Void)?
  var canceled: (() -> Void)?
  var tracking: NSTrackingArea?
  override var acceptsFirstResponder: Bool { true }
  override func updateTrackingAreas() {
    if let tracking { removeTrackingArea(tracking) }
    tracking = NSTrackingArea(
      rect: bounds, options: [.activeAlways, .mouseMoved, .inVisibleRect], owner: self)
    addTrackingArea(tracking!)
    super.updateTrackingAreas()
  }
  override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
  override func mouseMoved(with event: NSEvent) { point?(event, false) }
  override func mouseDown(with event: NSEvent) { point?(event, true) }
  override func mouseUp(with event: NSEvent) { released?() }
  override func keyDown(with event: NSEvent) { if event.keyCode == 53 { canceled?() } }
}
final class AccessibilityInspector {
  let pid: pid_t
  let application: AXUIElement
  var entries: [Int: AXUIElement] = [:], nextID = 2
  var live = Set<Int>()
  var panel: NSPanel?
  var pickerPanel: PickerPanel?
  var inspecting = false, captured = false, owner = "", hover = 0
  init(pid: pid_t) {
    self.pid = pid
    application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 1)
  }
  func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success
      ? result : nil
  }
  func id(_ element: AXUIElement) -> Int {
    if let existing = entries.first(where: { CFEqual($0.value, element) }) { return existing.key }
    let id = nextID
    nextID += 1
    entries[id] = element
    return id
  }
  func box(_ element: AXUIElement) -> CGRect {
    var point = CGPoint.zero
    var size = CGSize.zero
    if let raw = value(element, kAXPositionAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
      AXValueGetValue(raw as! AXValue, .cgPoint, &point)
    }
    if let raw = value(element, kAXSizeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
      AXValueGetValue(raw as! AXValue, .cgSize, &size)
    }
    return CGRect(origin: point, size: size)
  }
  func settable(_ element: AXUIElement, _ attr: String) -> Bool {
    var result = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attr as CFString, &result) == .success
      && result.boolValue
  }
  func snapshot() throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
      throw BridgeError.message(
        "Accessibility access is required. Allow AccessibilityBridge in System Settings → Privacy & Security → Accessibility, then retry attach."
      )
    }
    guard let windows = value(application, kAXWindowsAttribute) as? [AXUIElement],
      let window = windows.first
    else { throw BridgeError.message("Application has no accessible windows") }
    let bounds = box(window)
    var nodes: [[String: Any]] = []
    live.removeAll()
    func visit(_ element: AXUIElement, parent: Int, depth: Int) {
      guard depth < 64, nodes.count < 2048 else { return }
      let nodeID = id(element)
      if live.contains(nodeID) { return }
      live.insert(nodeID)
      let role = value(element, kAXRoleAttribute) as? String ?? "AXElement"
      let children = value(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
      let rect = box(element)
      var attrs = ["role": role, "data-native-id": "\(nodeID)"]
      for (name, attr) in [
        ("title", kAXTitleAttribute), ("value", kAXValueAttribute),
        ("description", kAXDescriptionAttribute), ("enabled", kAXEnabledAttribute),
        ("id", kAXIdentifierAttribute), ("focused", kAXFocusedAttribute),
      ] {
        if let v = value(element, attr),
          CFGetTypeID(v) == CFStringGetTypeID() || CFGetTypeID(v) == CFNumberGetTypeID()
            || CFGetTypeID(v) == CFBooleanGetTypeID()
        {
          attrs[name] = String(describing: v)
        }
      }
      let tag = role.replacingOccurrences(
        of: "([a-z0-9])([A-Z])", with: "$1-$2", options: .regularExpression
      ).replacingOccurrences(of: "^AX", with: "ax-", options: .regularExpression).lowercased()
      nodes.append([
        "id": nodeID, "parent": parent, "tag": tag, "text": attrs["title"] ?? attrs["value"] ?? "",
        "textMode": role == kAXStaticTextRole || role == kAXTextAreaRole
          ? "content"
          : attrs["value"] != nil ? "value" : attrs["title"] != nil ? "content" : "none",
        "attributes": attrs, "children": children.map { id($0) }, "x": rect.minX - bounds.minX,
        "y": rect.minY - bounds.minY, "width": rect.width, "height": rect.height, "styles": [:],
      ])
      for child in children { visit(child, parent: nodeID, depth: depth + 1) }
    }
    visit(window, parent: 1, depth: 0)
    // Remove edges truncated by the size/depth bound, never publish missing IDs.
    nodes = nodes.map { node in
      var node = node
      node["children"] = (node["children"] as? [Int] ?? []).filter { live.contains($0) }
      return node
    }
    entries = entries.filter { live.contains($0.key) }
    return [
      "nodes": nodes, "root": id(window), "width": bounds.width, "height": bounds.height,
      "title": value(window, kAXTitleAttribute) as? String ?? "Native app",
      "backend": "accessibility", "capabilities": ["attributes", "pick", "actions"],
    ]
  }
  func highlight(_ node: Int) {
    guard let element = entries[node], live.contains(node) else {
      panel?.orderOut(nil)
      return
    }
    let rect = box(element)
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    if panel == nil {
      let p = NSPanel(
        contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
        defer: false)
      p.level = .floating
      p.isOpaque = false
      p.backgroundColor = .clear
      p.hasShadow = false
      p.ignoresMouseEvents = true
      p.contentView = Border()
      p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      panel = p
    }
    panel?.setFrame(
      NSRect(x: rect.minX, y: top - rect.maxY, width: rect.width, height: rect.height),
      display: true)
    panel?.orderFrontRegardless()
  }
  func cancel() {
    inspecting = false
    if !captured {
      pickerPanel?.orderOut(nil)
      pickerPanel = nil
    }
    panel?.orderOut(nil)
  }
  func begin(owner: String) throws {
    guard !captured else {
      throw BridgeError.message("Finish the current picker gesture before rearming")
    }
    if inspecting && self.owner != owner {
      write(["method": "inspectCanceled", "params": ["owner": self.owner]])
    }
    cancel()
    self.owner = owner
    guard let windows = value(application, kAXWindowsAttribute) as? [AXUIElement],
      let window = windows.first
    else { throw BridgeError.message("Application has no accessible windows") }
    let rect = box(window)
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    let picker = PickerPanel(
      contentRect: NSRect(x: rect.minX, y: top - rect.maxY, width: rect.width, height: rect.height),
      styleMask: [.borderless], backing: .buffered, defer: false)
    picker.level = .floating
    picker.isOpaque = false
    picker.backgroundColor = .clear
    picker.hasShadow = false
    picker.acceptsMouseMovedEvents = true
    picker.isReleasedWhenClosed = false
    let surface = PickerSurface()
    surface.point = { [weak self] input, select in self?.input(input, select: select) }
    surface.released = { [weak self] in
      guard let self else { return }
      self.captured = false
      if !self.inspecting {
        self.pickerPanel?.orderOut(nil)
        self.pickerPanel = nil
      }
    }
    surface.canceled = { [weak self] in
      guard let self else { return }
      self.cancel()
      write(["method": "inspectCanceled", "params": ["owner": self.owner]])
      NSRunningApplication(processIdentifier: self.pid)?.activate(options: [
        .activateIgnoringOtherApps
      ])
    }
    picker.contentView = surface
    pickerPanel = picker
    inspecting = true
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps])
    picker.makeKeyAndOrderFront(nil)
    picker.makeFirstResponder(surface)
  }
  func input(_ input: NSEvent, select: Bool) {
    guard inspecting, let picker = pickerPanel else { return }
    let screenPoint = picker.convertPoint(toScreen: input.locationInWindow)
    let point = CGPoint(
      x: screenPoint.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - screenPoint.y)
    var element: AXUIElement?
    guard
      AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &element)
        == .success, let element
    else { return }
    let node = id(element)
    _ = try? snapshot()
    highlight(node)
    if select {
      // Keep the transparent input surface through mouse-up, so picking
      // cannot turn into a control action after DevTools exits inspect mode.
      captured = true
      inspecting = false
      write(["method": "picked", "params": ["owner": owner, "node": node]])
    } else if node != hover {
      hover = node
      write(["method": "hover", "params": ["owner": owner, "node": node]])
    }
  }
  func handle(_ method: String, _ params: [String: Any]) throws -> [String: Any] {
    if method == "snapshot" { return try snapshot() }
    if method == "highlight" {
      highlight(params["node"] as? Int ?? 0)
      return [:]
    }
    if method == "inspect" {
      if params["enabled"] as? Bool == true {
        try begin(owner: params["owner"] as? String ?? "")
      } else if params["owner"] as? String == owner {
        cancel()
      }
      return [:]
    }
    guard let node = params["node"] as? Int, let element = entries[node], live.contains(node) else {
      throw BridgeError.message("Stale accessibility element")
    }
    if method == "style" {
      throw BridgeError.message(
        "Accessibility does not expose appearance setters. Link MacInspector for live style editing."
      )
    }
    if method == "attribute" {
      let mapping = [
        "value": kAXValueAttribute, "title": kAXTitleAttribute, "focused": kAXFocusedAttribute,
      ]
      guard let attr = mapping[params["key"] as? String ?? ""], settable(element, attr) else {
        throw BridgeError.message("This accessibility attribute is read-only")
      }
      let string = params["value"] as? String ?? ""
      let current = value(element, attr)
      let newValue: CFTypeRef
      if attr == kAXFocusedAttribute {
        newValue = (string == "true") as CFBoolean
      } else if let current, CFGetTypeID(current) == CFNumberGetTypeID() {
        guard let number = Double(string), number.isFinite else {
          throw BridgeError.message("Native value must be a finite number")
        }
        newValue = NSNumber(value: number)
      } else {
        newValue = string as CFString
      }
      guard AXUIElementSetAttributeValue(element, attr as CFString, newValue) == .success else {
        throw BridgeError.message("Application rejected the accessibility edit")
      }
      return [:]
    }
    if method == "action" {
      if params["key"] as? String == "focus", settable(element, kAXFocusedAttribute) {
        guard
          AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            == .success
        else { throw BridgeError.message("Cannot focus this element") }
      } else {
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
          throw BridgeError.message("This element has no press action")
        }
      }
      return [:]
    }
    throw BridgeError.message("Unsupported accessibility operation: \(method)")
  }
}
func write(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data + Data([10]))
}
if CommandLine.arguments == [CommandLine.arguments[0], "--list-apps"] {
  let applications = NSWorkspace.shared.runningApplications
    .filter {
      $0.activationPolicy == .regular && !$0.isTerminated
        && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
    }
    .sorted {
      let comparison = ($0.localizedName ?? "").localizedCaseInsensitiveCompare(
        $1.localizedName ?? "")
      return comparison == .orderedSame
        ? $0.processIdentifier < $1.processIdentifier : comparison == .orderedAscending
    }
    .map { application -> [String: Any] in
      [
        "pid": Int(application.processIdentifier),
        "name": application.localizedName ?? application.executableURL?.lastPathComponent ?? "App",
        "bundleId": application.bundleIdentifier ?? "",
        "executable": application.executableURL?.lastPathComponent ?? "",
      ]
    }
  write(["apps": applications])
  exit(0)
}
guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]), pid > 0 else {
  fputs("Usage: AccessibilityBridge <pid> | --list-apps\n", stderr)
  exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let inspector = AccessibilityInspector(pid: pid)
DispatchQueue.global().async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8), data.count <= 65536,
      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { continue }
    DispatchQueue.main.async {
      do {
        write([
          "id": request["id"] ?? 0,
          "result": try inspector.handle(
            request["method"] as? String ?? "", request["params"] as? [String: Any] ?? [:]),
        ])
      } catch { write(["id": request["id"] ?? 0, "error": error.localizedDescription]) }
    }
  }
  DispatchQueue.main.async {
    inspector.cancel()
    app.terminate(nil)
  }
}
app.run()
