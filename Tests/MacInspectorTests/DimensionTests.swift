// SPDX-License-Identifier: MIT
import AppKit
import XCTest

@testable import MacInspector

final class DimensionTests: XCTestCase {
  func testSavedOverridesAndFailedImportsRestoreSizeConstraints() throws {
    let (window, view, width, height) = fixture()
    let inspector = NativeInspector(window: window)
    defer {
      inspector.stop()
      window.close()
    }
    let target = ["tag": "NSView", "id": "subject"]
    let document: [String: Any] = [
      "version": 1,
      "edits": [["target": target, "styles": [["name": "height", "value": "70px"]]]],
    ]
    try inspector.applyOverrides(JSONSerialization.data(withJSONObject: document))
    XCTAssertEqual(view.bounds.height, 70, accuracy: 0.5)
    XCTAssertFalse(height.isActive)
    let invalid: [String: Any] = [
      "version": 1,
      "edits": [
        ["target": target, "styles": [["name": "width", "value": "200px"]]],
        ["target": target, "styles": [["name": "height", "value": "-1px"]]],
      ],
    ]
    XCTAssertThrowsError(
      try inspector.applyOverrides(JSONSerialization.data(withJSONObject: invalid)))
    XCTAssertEqual(view.bounds.width, 100, accuracy: 0.5)
    XCTAssertEqual(view.bounds.height, 70, accuracy: 0.5)
    XCTAssertTrue(width.isActive)
    XCTAssertFalse(height.isActive)
  }

  private func fixture() -> (NSWindow, NSView, NSLayoutConstraint, NSLayoutConstraint) {
    _ = NSApplication.shared
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 500, height: 400), styleMask: [.titled],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    let view = NSView()
    view.identifier = .init("subject")
    view.translatesAutoresizingMaskIntoConstraints = false
    let root = window.contentView!
    root.addSubview(view)
    let width = view.widthAnchor.constraint(equalToConstant: 100)
    let height = view.heightAnchor.constraint(equalToConstant: 40)
    NSLayoutConstraint.activate([
      width, height,
      view.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
      view.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),
    ])
    root.layoutSubtreeIfNeeded()
    return (window, view, width, height)
  }

  func testSizeOverridesRestoreOriginalConstraintsAndReuseTheirIdentity() throws {
    let (window, view, width, height) = fixture()
    defer { window.close() }
    let styles = NativeStyles(view)
    let origin = view.frame.origin
    try styles.apply([
      ["key": "width", "value": "200px"], ["key": "height", "value": "60px"],
    ])
    XCTAssertEqual(view.bounds.width, 200, accuracy: 0.5)
    XCTAssertEqual(view.bounds.height, 60, accuracy: 0.5)
    XCTAssertFalse(width.isActive)
    XCTAssertFalse(height.isActive)
    XCTAssertEqual(width.constant, 100)
    XCTAssertEqual(height.constant, 40)
    XCTAssertEqual(view.frame.minX, origin.x, accuracy: 0.5)
    let owned = view.constraints.filter { $0.identifier?.hasPrefix("MacInspector.") == true }
    XCTAssertEqual(owned.count, 2)
    XCTAssertTrue(owned.allSatisfy { $0.priority.rawValue == 999 })
    for size in 201...220 {
      try styles.apply([["key": "width", "value": "\(size)px"]])
      XCTAssertEqual(view.bounds.width, CGFloat(size), accuracy: 0.5)
      XCTAssertEqual(view.constraints.filter { $0.identifier == "MacInspector.width" }.count, 1)
      XCTAssertTrue(
        view.constraints.contains { $0 === owned.first { $0.identifier == "MacInspector.width" } })
    }
    try styles.apply([["key": "height", "value": "auto"]])
    XCTAssertTrue(height.isActive)
    XCTAssertFalse(width.isActive)
    XCTAssertEqual(view.bounds.height, 40, accuracy: 0.5)
    XCTAssertEqual(styles.snapshot()["height"], "auto")
    try styles.apply([["key": "width", "reset": true], ["key": "height", "reset": true]])
    XCTAssertTrue(width.isActive)
    XCTAssertTrue(height.isActive)
    XCTAssertEqual(view.bounds.size, NSSize(width: 100, height: 40))
    XCTAssertNil(styles.snapshot()["width"])
    XCTAssertNil(styles.snapshot()["height"])
    XCTAssertFalse(view.translatesAutoresizingMaskIntoConstraints)
  }

  func testRequiredRelationshipsRejectAndRollbackEveryProperty() throws {
    let (window, view, width, height) = fixture()
    defer { window.close() }
    let styles = NativeStyles(view)
    let root = window.contentView!
    let pinned = view.trailingAnchor.constraint(equalTo: root.leadingAnchor, constant: 120)
    pinned.isActive = true
    root.layoutSubtreeIfNeeded()
    let baseline = styles.snapshot()
    XCTAssertThrowsError(
      try styles.apply([
        ["key": "height", "value": "80px"], ["key": "width", "value": "200px"],
        ["key": "opacity", "value": "0.5"],
      ])
    ) { error in
      XCTAssertTrue(String(describing: error).contains("Native Layout"))
    }
    XCTAssertEqual(styles.snapshot(), baseline)
    XCTAssertEqual(view.bounds.size, NSSize(width: 100, height: 40))
    XCTAssertTrue(width.isActive && height.isActive && pinned.isActive)
    XCTAssertFalse(view.constraints.contains { $0.identifier?.hasPrefix("MacInspector.") == true })

    pinned.isActive = false
    try styles.apply([["key": "width", "value": "180px"]])
    let edited = styles.snapshot()
    XCTAssertThrowsError(
      try styles.apply([["key": "width", "value": "220px"], ["key": "height", "value": "-1px"]]))
    XCTAssertEqual(styles.snapshot(), edited)
    XCTAssertEqual(view.bounds.width, 180, accuracy: 0.5)
    XCTAssertTrue(height.isActive)
  }

  func testCheckpointAndInvalidSizesPreserveNativeState() throws {
    let (window, view, width, height) = fixture()
    defer { window.close() }
    let styles = NativeStyles(view)
    try styles.apply([["key": "height", "value": "70px"]])
    let restore = try styles.checkpoint([["key": "height", "value": "90px"]])
    try styles.apply([["key": "height", "value": "90px"]])
    restore()
    XCTAssertEqual(view.bounds.height, 70, accuracy: 0.5)
    XCTAssertEqual(styles.snapshot()["height"], "70.0px")
    for value in ["-1px", "10%", "calc(10px + 2px)", "NaN", "inf", "10001px", "10pxjunk"] {
      XCTAssertThrowsError(try styles.apply([["key": "height", "value": value]]))
      XCTAssertEqual(view.bounds.height, 70, accuracy: 0.5)
    }
    XCTAssertTrue(width.isActive)
    XCTAssertFalse(height.isActive)
    try styles.apply([["key": "height", "reset": true]])
    XCTAssertTrue(height.isActive)
    view.translatesAutoresizingMaskIntoConstraints = true
    XCTAssertThrowsError(try styles.apply([["key": "height", "value": "90px"]]))
    XCTAssertTrue(view.translatesAutoresizingMaskIntoConstraints)
  }
}
