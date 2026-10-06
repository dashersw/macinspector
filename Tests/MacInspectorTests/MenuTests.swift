// SPDX-License-Identifier: MIT
import AppKit
import XCTest

@testable import MacInspector

private final class MenuActionProbe: NSObject {
  var calls = 0
  var title = ""
  @objc func activate(_ sender: AnyObject) {
    calls += 1
    title = (sender as? NSPopUpButton)?.titleOfSelectedItem ?? (sender as? NSMenuItem)?.title ?? ""
  }
}

final class MenuTests: XCTestCase {
  private func window() -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 300, height: 220),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    return window
  }
  private func nodes(_ inspector: NativeInspector) -> [[String: Any]] {
    inspector.snapshot()["nodes"] as! [[String: Any]]
  }
  private func attrs(_ node: [String: Any]) -> [String: String] {
    node["attributes"] as! [String: String]
  }
  func testDropdownItemsRemainVisibleWhileClosedAndUseNativeSelectionAndActions() throws {
    let window = window()
    let popup = NSPopUpButton(frame: NSRect(x: 20, y: 20, width: 160, height: 30))
    popup.addItems(withTitles: ["Berlin", "London", "Tokyo"])
    popup.identifier = .init("cities")
    window.contentView!.addSubview(popup)
    let probe = MenuActionProbe()
    popup.target = probe
    popup.action = #selector(MenuActionProbe.activate(_:))
    let inspector = NativeInspector(window: window)
    defer {
      inspector.stop()
      window.close()
    }
    let snapshot = nodes(inspector)
    let control = snapshot.first { attrs($0)["id"] == "cities" }!
    let menu = snapshot.first {
      $0["parent"] as? Int == control["id"] as? Int && $0["tag"] as? String == "NSMenu"
    }!
    let items = snapshot.filter { $0["parent"] as? Int == menu["id"] as? Int }
    XCTAssertEqual(items.map { attrs($0)["title"]! }, ["Berlin", "London", "Tokyo"])
    XCTAssertEqual(items.map { attrs($0)["selected"]! }, ["true", "false", "false"])
    XCTAssertEqual(
      nodes(inspector).filter { $0["parent"] as? Int == menu["id"] as? Int }.map {
        $0["id"] as! Int
      }, items.map { $0["id"] as! Int })
    let berlin = items[0]["id"] as! Int
    let london = items[1]["id"] as! Int
    let tokyo = items[2]["id"] as! Int
    _ = try inspector.handle("attribute", ["node": london, "key": "selected", "value": "true"])
    XCTAssertEqual(popup.titleOfSelectedItem, "London")
    XCTAssertEqual(probe.calls, 0, "Property writes do not dispatch actions")
    _ = try inspector.handle("action", ["node": berlin, "key": "press"])
    XCTAssertEqual(probe.calls, 1)
    XCTAssertEqual(probe.title, "Berlin")
    let itemProbe = MenuActionProbe()
    popup.item(at: 1)!.target = itemProbe
    popup.item(at: 1)!.action = #selector(MenuActionProbe.activate(_:))
    _ = try inspector.handle("action", ["node": london, "key": "press"])
    XCTAssertEqual(itemProbe.calls, 1, "An item's own target/action takes precedence")
    XCTAssertEqual(probe.calls, 1)
    XCTAssertEqual(popup.titleOfSelectedItem, "London")
    _ = try inspector.handle("attribute", ["node": berlin, "key": "selected", "value": "true"])
    _ = try inspector.handle("attribute", ["node": tokyo, "key": "enabled", "value": "false"])
    XCTAssertThrowsError(try inspector.handle("action", ["node": tokyo, "key": "press"]))
    XCTAssertEqual(popup.titleOfSelectedItem, "Berlin")
    _ = try inspector.handle(
      "attribute", ["node": berlin, "key": "title", "value": "Berlin Mitte"])
    XCTAssertEqual(popup.titleOfSelectedItem, "Berlin Mitte")
    let retained = popup.item(at: 1)!
    popup.removeItem(at: 1)
    XCTAssertNil(retained.menu)
    XCTAssertThrowsError(try inspector.handle("action", ["node": london, "key": "press"]))
    let detachedMenu = popup.menu!
    popup.menu = NSMenu(title: "Replacement")
    XCTAssertFalse(detachedMenu.items.isEmpty)
    XCTAssertThrowsError(
      try inspector.handle("attribute", ["node": berlin, "key": "title", "value": "Detached"]))
  }
  func testSharedContextMenusHaveSeparateBranchesAndSubmenuActionsRespectAncestors() throws {
    let window = window()
    let first = NSView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
    let second = NSView(frame: NSRect(x: 100, y: 0, width: 100, height: 100))
    first.identifier = .init("first")
    second.identifier = .init("second")
    window.contentView!.addSubview(first)
    window.contentView!.addSubview(second)
    let menu = NSMenu(title: "Context")
    menu.autoenablesItems = false
    let parent = NSMenuItem(title: "More", action: nil, keyEquivalent: "")
    let submenu = NSMenu(title: "More")
    submenu.autoenablesItems = false
    let probe = MenuActionProbe()
    let leaf = NSMenuItem(
      title: "Refresh", action: #selector(MenuActionProbe.activate(_:)), keyEquivalent: "r")
    leaf.target = probe
    submenu.addItem(leaf)
    parent.submenu = submenu
    menu.addItem(parent)
    menu.addItem(.separator())
    first.menu = menu
    second.menu = menu
    let inspector = NativeInspector(window: window)
    defer {
      inspector.stop()
      window.close()
    }
    let snapshot = nodes(inspector)
    let menus = snapshot.filter {
      $0["tag"] as? String == "NSMenu" && attrs($0)["title"] == "Context"
    }
    XCTAssertEqual(menus.count, 2)
    XCTAssertNotEqual(menus[0]["id"] as? Int, menus[1]["id"] as? Int)
    XCTAssertEqual(snapshot.filter { attrs($0)["separator"] == "true" }.count, 2)
    let leaves = snapshot.filter { attrs($0)["title"] == "Refresh" }
    XCTAssertEqual(leaves.count, 2)
    XCTAssertNotEqual(leaves[0]["id"] as? Int, leaves[1]["id"] as? Int)
    let leafID = leaves[0]["id"] as! Int
    let otherLeafID = leaves[1]["id"] as! Int
    _ = try inspector.handle("action", ["node": leafID, "key": "press"])
    XCTAssertEqual(probe.calls, 1)
    XCTAssertEqual(probe.title, "Refresh")
    parent.isEnabled = false
    XCTAssertThrowsError(try inspector.handle("action", ["node": leafID, "key": "press"]))
    parent.isEnabled = true
    parent.isHidden = true
    XCTAssertThrowsError(try inspector.handle("action", ["node": leafID, "key": "press"]))
    parent.isHidden = false
    first.menu = nil
    XCTAssertThrowsError(try inspector.handle("action", ["node": leafID, "key": "press"]))
    _ = try inspector.handle("action", ["node": otherLeafID, "key": "press"])
    XCTAssertEqual(probe.calls, 2)
    XCTAssertEqual(nodes(inspector).filter { attrs($0)["title"] == "Refresh" }.count, 1)
  }
}
