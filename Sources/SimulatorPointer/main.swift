// SPDX-License-Identifier: MIT
import AppKit
import CoreGraphics

// Observe geometry and pointer position only. Input continues to go to Simulator
// and the UIKit picker; there is no event tap, input synthesis or screen capture.
final class SimulatorPointer {
  var enabled = false
  var device = ""
  private var status = ""

  private func write(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
  }

  private func unavailable(_ reason: String) {
    if status != reason {
      status = reason
      write(["method": "unavailable", "params": ["reason": reason]])
    }
    write(["method": "pointer", "params": ["inside": false]])
  }

  func sample() {
    guard enabled else { return }
    let simulatorPIDs = Set(
      NSWorkspace.shared.runningApplications
        .filter { $0.bundleIdentifier == "com.apple.iphonesimulator" }
        .map { Int($0.processIdentifier) })
    let windows =
      CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let matches = windows.enumerated().filter { _, window in
      simulatorPIDs.contains(window[kCGWindowOwnerPID as String] as? Int ?? 0)
        && window[kCGWindowLayer as String] as? Int == 0
        && window[kCGWindowName as String] as? String == device
    }
    guard matches.count == 1, let (index, window) = matches.first,
      let bounds = window[kCGWindowBounds as String] as? [String: Any],
      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
      let point = CGEvent(source: nil)?.location
    else {
      unavailable("Show exactly one Simulator window named \(device) for pointer hover.")
      return
    }
    status = ""
    let foreground = windows.prefix(index).compactMap { other -> [String: Any]? in
      guard (other[kCGWindowAlpha as String] as? Double ?? 1) > 0,
        let raw = other[kCGWindowBounds as String] as? [String: Any],
        let box = CGRect(dictionaryRepresentation: raw as CFDictionary)
      else { return nil }
      return [
        "layer": other[kCGWindowLayer as String] as? Int ?? -1,
        "x": box.minX, "y": box.minY, "width": box.width, "height": box.height,
      ]
    }
    write([
      "method": "pointer",
      "params": [
        "inside": rect.contains(point), "foreground": foreground,
        "pointer": ["x": point.x, "y": point.y],
        "window": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height],
      ],
    ])
  }

  func configure(_ configuration: [String: Any]) {
    device = configuration["device"] as? String ?? ""
    enabled = configuration["enabled"] as? Bool == true && !device.isEmpty
    status = ""
    sample()
  }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let pointer = SimulatorPointer()
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in pointer.sample() }
RunLoop.main.add(timer, forMode: .common)
DispatchQueue.global().async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8), data.count <= 16384,
      let configuration = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { continue }
    DispatchQueue.main.async { pointer.configure(configuration) }
  }
  DispatchQueue.main.async { application.terminate(nil) }
}
application.run()
