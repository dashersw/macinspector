// SPDX-License-Identifier: MIT
import AppKit
import MacInspector
import SwiftUI

final class ShowcaseDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1100, height: 880),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "SwiftUI Showcase"
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 560, height: 520)
    window.backgroundColor = .windowBackgroundColor
    window.contentView = NSHostingView(rootView: ShowcaseView().macInspectorRoot())
    window.center()
    window.makeKeyAndOrderFront(nil)
    self.window = window
    NSApplication.shared.activate(ignoringOtherApps: true)
  }

  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct SwiftUIShowcaseApp {
  static func main() {
    let app = NSApplication.shared
    let delegate = ShowcaseDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) { app.run() }
  }
}
