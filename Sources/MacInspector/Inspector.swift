// SPDX-License-Identifier: MIT
#if canImport(AppKit)
  import AppKit
  import Network
  import QuartzCore
  import ScreenCaptureKit

  private struct NativeKey: Hashable {
    let object: ObjectIdentifier
    let owner: ObjectIdentifier?
  }

  private final class NativeReference {
    weak var object: NSObject?
    weak var owner: NSView?
    weak var parent: NSObject?
    var view: NSView? { object as? NSView }
    let id: Int
    init(_ object: NSObject, _ id: Int, owner: NSView?, parent: NSObject?) {
      self.object = object
      self.id = id
      self.owner = owner
      self.parent = parent
    }
  }

  private final class Outline: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
      NSColor.systemBlue.withAlphaComponent(0.15).setFill()
      bounds.fill()
      NSColor.systemBlue.setStroke()
      let path = NSBezierPath(rect: bounds.insetBy(dx: 1, dy: 1))
      path.lineWidth = 2
      path.stroke()
    }
  }

  /// Add to an application's debug build. Native objects stay in their own process;
  /// the local relay receives bounded JSON operations, never arbitrary selectors.
  public final class NativeInspector {
    private weak var window: NSWindow?
    private let server = NativeServer()
    public var connectionError: Error? { server.connectionError }
    private var references: [NativeKey: NativeReference] = [:]
    private var byID: [Int: NativeReference] = [:]
    private var nextID = 3
    var styleEditors: [Int: NativeStyles] = [:]
    let layout = NativeLayout()
    private let constraintOverlay = ConstraintOverlay()
    private var outline: Outline?
    private var outlined: Int = 0
    private var monitor: Any?
    private var inspecting = false, captured = false, priorMouseMoved = false
    private var owner = ""
    private var hover = 0
    public var emit: ((String, [String: Any]) -> Void)?

    public init(window: NSWindow) { self.window = window }

    /// Bind only to loopback and require the relay's random session secret.
    public func start(port: UInt16 = 0, token: String? = nil) throws {
      server.screenshot = { [weak self] completion in
        guard let self, let window = self.window else {
          completion(.failure(InspectorError.invalid("Window closed")))
          return
        }
        if SwiftUIInspectionRegistry.find(window) != nil {
          guard #available(macOS 14.4, *) else {
            completion(.failure(InspectorError.invalid("SwiftUI window screenshots require macOS 14.4 or later")))
            return
          }
          self.captureSwiftUI(window, completion: completion)
        } else {
          do { completion(.success(try self.handle("screenshot", [:]))) }
          catch { completion(.failure(error)) }
        }
      }
      try server.start(
        port: port, token: token, title: window?.title ?? "Native app",
        handler: { [weak self] method, params in
          guard let self else { throw InspectorError.invalid("Inspector closed") }
          return try self.handle(method, params)
        },
        disconnected: { [weak self] in
          self?.cancelInspection()
          self?.highlight(0)
          self?.constraintOverlay.removeFromSuperview()
        })
    }

    @available(macOS 14.4, *)
    private func captureSwiftUI(
      _ window: NSWindow, completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
      let number = CGWindowID(window.windowNumber)
      let frame = window.frame
      let content = window.contentRect(forFrameRect: frame)
      // This API exposes content available to our process without new TCC consent.
      // Capture only this inspector's own window; never request desktop content.
      SCShareableContent.getCurrentProcessShareableContent { available, error in
        guard let captured = available?.windows.first(where: {
          $0.windowID == number && $0.owningApplication?.processID == getpid()
        }) else {
          completion(.failure(error ?? InspectorError.invalid("SwiftUI window is not available for capture")))
          return
        }
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(content.width.rounded()))
        configuration.height = max(1, Int(content.height.rounded()))
        configuration.sourceRect = CGRect(
          x: content.minX - frame.minX, y: frame.maxY - content.maxY,
          width: content.width, height: content.height)
        configuration.ignoreShadowsSingleWindow = true
        configuration.showsCursor = false
        configuration.scalesToFit = false
        SCScreenshotManager.captureImage(
          contentFilter: SCContentFilter(desktopIndependentWindow: captured), configuration: configuration
        ) { image, error in
          guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            completion(.failure(error ?? InspectorError.invalid("SwiftUI screenshot encoding failed")))
            return
          }
          completion(.success(["data": png.base64EncodedString()]))
        }
      }
    }

    public func stop() {
      cancelInspection()
      highlight(0)
      constraintOverlay.removeFromSuperview()
      layout.clear()
      server.stop()
    }

    func relayout() { window?.contentView?.layoutSubtreeIfNeeded() }

    private func event(_ method: String, _ params: [String: Any]) {
      emit?(method, params)
      server.emit(method, params)
    }
    func id(_ object: NSObject, owner: NSView? = nil, parent: NSObject? = nil) -> Int {
      let key = NativeKey(object: ObjectIdentifier(object), owner: owner.map(ObjectIdentifier.init))
      if let existing = references[key], existing.object === object, existing.owner === owner {
        existing.parent = parent
        return existing.id
      }
      let ref = NativeReference(object, nextID, owner: owner, parent: parent)
      nextID += 1
      references[key] = ref
      byID[ref.id] = ref
      return ref.id
    }
    func view(_ id: Int) throws -> NSView {
      let object = try object(id)
      if let logical = object as? SwiftUIInspectionNode, let probe = logical.probe { return probe }
      guard let view = object as? NSView else {
        throw InspectorError.invalid("This native object has no view appearance or frame")
      }
      return view
    }
    func object(_ id: Int) throws -> NSObject {
      guard let reference = byID[id], let object = reference.object else {
        throw InspectorError.invalid("Stale or detached native element")
      }
      if let logical = object as? SwiftUIInspectionNode {
        try logical.registry?.validate(logical)
        guard logical.attached, logical.probe?.window === window else {
          throw InspectorError.invalid("Detached SwiftUI view")
        }
        return object
      }
      if let view = object as? NSView {
        guard view.window === window, view !== outline, view !== constraintOverlay else {
          throw InspectorError.invalid("Stale or detached native element")
        }
      } else {
        guard let owner = reference.owner, owner.window === window else {
          throw InspectorError.invalid("Stale or detached native menu")
        }
        var current = reference
        var seen = Set<Int>()
        while seen.insert(current.id).inserted, seen.count <= 64 {
          guard let child = current.object, let parent = current.parent else { break }
          if parent === owner {
            if let menu = child as? NSMenu, owner.menu === menu { return object }
            break
          }
          let attached: Bool
          if let item = child as? NSMenuItem, let menu = parent as? NSMenu {
            attached = item.menu === menu
          } else if let menu = child as? NSMenu, let item = parent as? NSMenuItem {
            attached = item.submenu === menu
          } else {
            attached = false
          }
          let key = NativeKey(object: ObjectIdentifier(parent), owner: ObjectIdentifier(owner))
          guard attached, let next = references[key] else { break }
          current = next
        }
        throw InspectorError.invalid("Stale or detached native menu item")
      }
      return object
    }
    private func rect(_ view: NSView) -> NSRect {
      guard let root = window?.contentView else { return .zero }
      let bounds = root.convert(view.bounds, from: view)
      return NSRect(
        x: bounds.minX, y: root.isFlipped ? bounds.minY : root.bounds.height - bounds.maxY,
        width: bounds.width, height: bounds.height)
    }
    public func snapshot() -> [String: Any] {
      precondition(Thread.isMainThread)
      guard let window, let root = window.contentView else { return ["nodes": [], "root": 2] }
      references = references.filter {
        $0.value.object != nil && ($0.key.owner == nil || $0.value.owner != nil)
      }
      byID = byID.filter {
        $0.value.object != nil && ($0.value.view != nil || $0.value.owner != nil || $0.value.object is SwiftUIInspectionNode)
      }
      styleEditors = styleEditors.filter { byID[$0.key] != nil }
      let box = root.bounds
      var nodes: [[String: Any]] = [
        [
          "id": 2, "parent": 1, "tag": NSStringFromClass(type(of: window)), "text": "",
          "attributes": ["title": window.title], "children": [id(root)], "x": 0,
          "y": 0, "width": box.width, "height": box.height, "styles": [:],
        ]
      ]
      func visitMenu(
        _ menu: NSMenu, owner: NSView, parent: NSObject, parentID: Int,
        path: Set<ObjectIdentifier> = []
      ) {
        guard !path.contains(ObjectIdentifier(menu)), path.count < 64 else { return }
        let path = path.union([ObjectIdentifier(menu)])
        let menuID = id(menu, owner: owner, parent: parent)
        nodes.append([
          "id": menuID, "parent": parentID, "tag": NSStringFromClass(type(of: menu)), "text": "",
          "attributes": ["data-native-id": "\(menuID)", "title": menu.title],
          "children": menu.items.map { id($0, owner: owner, parent: menu) },
          "x": 0, "y": 0, "width": 0, "height": 0, "styles": [:],
        ])
        for (index, item) in menu.items.enumerated() {
          let itemID = id(item, owner: owner, parent: menu)
          var attrs = [
            "data-native-id": "\(itemID)", "title": item.title, "index": "\(index)",
            "enabled": "\(item.isEnabled)", "hidden": "\(item.isHidden)",
            "separator": "\(item.isSeparatorItem)",
            "checked": item.state == .on ? "true" : item.state == .mixed ? "mixed" : "false",
          ]
          if let identifier = item.identifier?.rawValue { attrs["id"] = identifier }
          if let popup = owner as? NSPopUpButton, popup.menu === menu {
            attrs["selected"] = "\(popup.selectedItem === item)"
          }
          if !item.keyEquivalent.isEmpty {
            attrs["key-equivalent"] = item.keyEquivalent
            attrs["key-equivalent-modifiers"] = "\(item.keyEquivalentModifierMask.rawValue)"
          }
          let submenu = item.submenu.flatMap {
            !path.contains(ObjectIdentifier($0)) && path.count < 64 ? $0 : nil
          }
          nodes.append([
            "id": itemID, "parent": menuID, "tag": NSStringFromClass(type(of: item)),
            "text": item.title,
            "listeners": NativeEvents.listeners(item),
            "attributes": attrs,
            "children": submenu.map { [id($0, owner: owner, parent: item)] } ?? [],
            "x": 0, "y": 0, "width": 0, "height": 0, "styles": [:],
          ])
          if let submenu {
            visitMenu(submenu, owner: owner, parent: item, parentID: itemID, path: path)
          }
        }
      }
      func visit(_ view: NSView, parent: Int) {
        if view === outline || view === constraintOverlay { return }
        let nodeID = id(view)
        let measured = rect(view)
        // Degenerate internal coordinate spaces must not drop a JSON reply.
        let valid = [measured.minX, measured.minY, measured.width, measured.height].allSatisfy {
          $0.isFinite
        }
        let bounds = valid ? measured : NSRect.zero
        let children = view.subviews.filter { $0 !== outline && $0 !== constraintOverlay }
        var attrs = ["data-native-id": "\(nodeID)"]
        if !valid { attrs["layout-valid"] = "false" }
        if let identifier = view.identifier?.rawValue { attrs["id"] = identifier }
        if let control = view as? NSControl { attrs["enabled"] = "\(control.isEnabled)" }
        var text = ""
        var textMode = "none"
        if let popup = view as? NSPopUpButton {
          text = popup.title
          textMode = "value"
          attrs["title"] = popup.title
          attrs["value"] = popup.titleOfSelectedItem ?? ""
          attrs["selected-index"] = "\(popup.indexOfSelectedItem)"
          attrs["enabled"] = "\(popup.isEnabled)"
        } else if let button = view as? NSButton {
          text = button.title
          textMode = "content"
          attrs["title"] = button.title
          attrs["enabled"] = "\(button.isEnabled)"
          attrs["checked"] =
            button.state == .on ? "true" : button.state == .mixed ? "mixed" : "false"
        } else if let textField = view as? NSTextField {
          text = textField.stringValue
          textMode = textField.isEditable ? "value" : "content"
          attrs["value"] = text
        } else if let textView = view as? NSTextView {
          text = textView.string
          textMode = "content"
        } else if let slider = view as? NSSlider {
          attrs["value"] = "\(slider.doubleValue)"
        } else if let toggle = view as? NSSwitch {
          attrs["checked"] = toggle.state == .on ? "true" : "false"
        } else if let segment = view as? NSSegmentedControl {
          attrs["value"] = "\(segment.selectedSegment)"
        } else if let picker = view as? NSDatePicker {
          attrs["value"] = ISO8601DateFormatter().string(from: picker.dateValue)
        }
        nodes.append([
          "id": nodeID, "parent": parent, "tag": NSStringFromClass(type(of: view)), "text": text,
          "textMode": textMode,
          "listeners": NativeEvents.listeners(view),
          "attributes": attrs,
          "children": children.map { id($0) }
            + (view.menu.map { [id($0, owner: view, parent: view)] } ?? []), "x": bounds.minX,
          "y": bounds.minY,
          "width": bounds.width, "height": bounds.height,
          "styles": styleEditors[nodeID]?.snapshot() ?? NativeStyles.snapshot(view),
        ])
        for child in children { visit(child, parent: nodeID) }
        if let menu = view.menu { visitMenu(menu, owner: view, parent: view, parentID: nodeID) }
      }
      let swiftUI = SwiftUIInspectionRegistry.find(window)
      let supportsCapture: Bool
      if #available(macOS 14.4, *) { supportsCapture = true }
      else { supportsCapture = swiftUI == nil }
      if let swiftUI {
        let logical = swiftUI.snapshot(id: { self.id($0) }, measure: rect)
        nodes[0]["children"] = logical.roots
        nodes += logical.nodes
      } else {
        visit(root, parent: 2)
      }
      if outlined != 0 { highlight(outlined) }
      return [
        "nodes": nodes, "root": 2, "width": box.width, "height": box.height,
        "title": window.title, "backend": "appkit",
        "pid": Int(ProcessInfo.processInfo.processIdentifier),
        "bundleId": Bundle.main.bundleIdentifier ?? "", "session": server.record.session,
        "capabilities": [
          "styles", "attributes", "attribute-state", "pick", "screenshot", "actions", "layout",
          "event-listeners",
        ].filter { ($0 != "layout" || swiftUI == nil) && ($0 != "screenshot" || supportsCapture) } + (swiftUI == nil ? [] : ["swiftui"]),
        "styleProperties": swiftUI == nil ? NativeStyles.properties :
          Array(Set(nodes.flatMap { Array(($0["styles"] as? [String: String] ?? [:]).keys) } + ["background"])).sorted(),
      ]
    }
    func attributeState(_ object: NSObject, node: Int, key: String) throws -> [String: Any] {
      if let logical = object as? SwiftUIInspectionNode {
        let property = try logical.attribute(key)
        return ["node": node, "key": property.key, "value": property.read()]
      }
      var target = node
      var property = key
      let value: String
      if let view = object as? NSView {
        switch key {
        case "id": value = view.identifier?.rawValue ?? ""
        case "value", "title", "text":
          if let popup = view as? NSPopUpButton, key == "value" {
            property = "selected-index"
            value = String(popup.indexOfSelectedItem)
          } else if let field = view as? NSTextField {
            property = "value"
            value = field.stringValue
          } else if let text = view as? NSTextView {
            property = "text"
            value = text.string
          } else if let button = view as? NSButton {
            property = "title"
            value = button.title
          } else if let slider = view as? NSSlider {
            property = "value"
            value = String(slider.doubleValue)
          } else if let segment = view as? NSSegmentedControl {
            property = "value"
            value = String(segment.selectedSegment)
          } else {
            throw InspectorError.invalid("This element has no editable native value")
          }
        case "selected-index":
          guard let popup = view as? NSPopUpButton else {
            throw InspectorError.invalid("Not a dropdown")
          }
          value = String(popup.indexOfSelectedItem)
        case "enabled":
          guard let control = view as? NSControl else {
            throw InspectorError.invalid("Not a control")
          }
          value = control.isEnabled ? "true" : "false"
        case "checked":
          if let button = view as? NSButton {
            value = button.state == .on ? "true" : button.state == .mixed ? "mixed" : "false"
          } else if let toggle = view as? NSSwitch {
            value = toggle.state == .on ? "true" : "false"
          } else {
            throw InspectorError.invalid("This control has no checked state")
          }
        default: throw InspectorError.invalid("Unsupported native attribute: \(key)")
        }
      } else if let menu = object as? NSMenu, key == "title" {
        value = menu.title
      } else if let item = object as? NSMenuItem {
        switch key {
        case "id": value = item.identifier?.rawValue ?? ""
        case "value", "title", "text":
          property = "title"
          value = item.title
        case "enabled": value = item.isEnabled ? "true" : "false"
        case "hidden": value = item.isHidden ? "true" : "false"
        case "checked":
          value = item.state == .on ? "true" : item.state == .mixed ? "mixed" : "false"
        case "selected":
          guard let popup = byID[node]?.owner as? NSPopUpButton, item.menu === popup.menu else {
            throw InspectorError.invalid("Not a dropdown item")
          }
          target = id(popup)
          property = "selected-index"
          value = String(popup.indexOfSelectedItem)
        default: throw InspectorError.invalid("Unsupported native menu attribute: \(key)")
        }
      } else {
        throw InspectorError.invalid("This object has no editable native attribute")
      }
      return ["node": target, "key": property, "value": value]
    }

    func setAttribute(_ view: NSView, key: String, value: String) throws {
      switch key {
      case "id": view.identifier = value.isEmpty ? nil : NSUserInterfaceItemIdentifier(value)
      case "value", "title", "text":
        if let popup = view as? NSPopUpButton, key == "value" {
          guard let item = popup.itemArray.first(where: { $0.title == value }) else {
            throw InspectorError.invalid("No dropdown item has that title")
          }
          popup.select(item)
        } else if let text = view as? NSTextField {
          text.stringValue = value
        } else if let text = view as? NSTextView {
          text.string = value
        } else if let button = view as? NSButton {
          button.title = value
        } else if let slider = view as? NSSlider, let value = Double(value), value.isFinite,
          value >= slider.minValue, value <= slider.maxValue
        {
          slider.doubleValue = value
        } else if let segment = view as? NSSegmentedControl, let value = Int(value), value >= -1,
          value < segment.segmentCount
        {
          segment.selectedSegment = value
        } else {
          throw InspectorError.invalid("This element does not support that native value")
        }
      case "selected-index":
        guard let popup = view as? NSPopUpButton, let index = Int(value),
          index == -1 || popup.itemArray.indices.contains(index)
        else {
          throw InspectorError.invalid("selected-index requires a valid dropdown item index")
        }
        if index == -1 { popup.select(nil) } else { popup.selectItem(at: index) }
      case "enabled":
        guard let control = view as? NSControl, ["true", "false"].contains(value) else {
          throw InspectorError.invalid("enabled requires a control and true/false")
        }
        control.isEnabled = value == "true"
      case "checked":
        guard ["true", "false", "mixed"].contains(value) else {
          throw InspectorError.invalid("checked requires true/false/mixed")
        }
        if let toggle = view as? NSSwitch {
          guard value != "mixed" else {
            throw InspectorError.invalid("Switches have no mixed state")
          }
          toggle.state = value == "true" ? .on : .off
        } else if let button = view as? NSButton {
          button.state = value == "true" ? .on : value == "mixed" ? .mixed : .off
        } else {
          throw InspectorError.invalid("This native control has no checked state")
        }
      default: throw InspectorError.invalid("Read-only or unsupported native attribute: \(key)")
      }
    }
    func setAttribute(_ object: NSObject, node: Int, key: String, value: String) throws {
      if let logical = object as? SwiftUIInspectionNode { return try logical.setAttribute(key, value: value) }
      if let view = object as? NSView { return try setAttribute(view, key: key, value: value) }
      if let menu = object as? NSMenu, key == "title" {
        menu.title = value
        return
      }
      guard let item = object as? NSMenuItem else {
        throw InspectorError.invalid("Read-only or unsupported native menu attribute: \(key)")
      }
      switch key {
      case "id": item.identifier = value.isEmpty ? nil : NSUserInterfaceItemIdentifier(value)
      case "title", "text": item.title = value
      case "key-equivalent": item.keyEquivalent = value
      case "enabled", "hidden", "selected":
        guard ["true", "false"].contains(value) else {
          throw InspectorError.invalid("\(key) requires true/false")
        }
        if key == "enabled" {
          item.isEnabled = value == "true"
        } else if key == "hidden" {
          item.isHidden = value == "true"
        } else {
          guard let popup = byID[node]?.owner as? NSPopUpButton, item.menu === popup.menu,
            !item.isSeparatorItem
          else {
            throw InspectorError.invalid("Only dropdown items have a selected state")
          }
          if value == "true" {
            popup.select(item)
          } else if popup.selectedItem === item {
            popup.select(nil)
          }
        }
      case "checked":
        guard ["true", "false", "mixed"].contains(value) else {
          throw InspectorError.invalid("checked requires true/false/mixed")
        }
        item.state = value == "true" ? .on : value == "mixed" ? .mixed : .off
      default:
        throw InspectorError.invalid("Read-only or unsupported native menu attribute: \(key)")
      }
    }
    private func press(_ item: NSMenuItem, node: Int) throws {
      guard item.isEnabled, !item.isHidden, !item.isSeparatorItem, item.submenu == nil,
        let menu = item.menu, let owner = byID[node]?.owner,
        !owner.isHiddenOrHasHiddenAncestor, (owner as? NSControl)?.isEnabled != false
      else { throw InspectorError.invalid("This menu item cannot be activated") }
      var ancestor = byID[node]?.parent
      while let current = ancestor, current !== owner {
        if let parentItem = current as? NSMenuItem, !parentItem.isEnabled || parentItem.isHidden {
          throw InspectorError.invalid("This menu item's submenu is disabled or hidden")
        }
        let key = NativeKey(object: ObjectIdentifier(current), owner: ObjectIdentifier(owner))
        ancestor = references[key]?.parent
      }
      if let popup = owner as? NSPopUpButton, popup.menu === menu {
        popup.select(item)
        if item.action != nil {
          menu.performActionForItem(at: menu.index(of: item))
        } else if let action = popup.action {
          popup.sendAction(action, to: popup.target)
        }
      } else {
        guard item.action != nil else {
          throw InspectorError.invalid("This menu item has no native action")
        }
        menu.performActionForItem(at: menu.index(of: item))
      }
    }
    public func highlight(_ node: Int) {
      outline?.removeFromSuperview()
      outlined = 0
      guard node > 2, let view = try? view(node), let root = window?.contentView else { return }
      let layer = outline ?? Outline()
      outline = layer
      let container = window.flatMap(SwiftUIInspectionRegistry.find)?.overlayRoot ?? root
      let bounds = container.convert(view.bounds, from: view)
      guard [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy({ $0.isFinite })
      else {
        return
      }
      layer.frame = bounds
      container.addSubview(layer, positioned: .above, relativeTo: nil)
      outlined = node
    }
    private func inspectPoint(_ point: NSPoint) -> Int {
      guard let root = window?.contentView else { return 0 }
      if let registry = window.flatMap(SwiftUIInspectionRegistry.find) {
        return registry.pick(point, in: root).map { id($0) } ?? 0
      }
      let hidden = outline?.isHidden
      outline?.isHidden = true
      // NSView.hitTest takes its superview's coordinates. In particular, a
      // flipped content view must convert back to window coordinates first.
      let hit = root.hitTest(root.convert(point, to: root.superview))
      if let hidden { outline?.isHidden = hidden }
      return hit.map { id($0) } ?? 0
    }
    public func beginInspection(owner: String) {
      if inspecting && self.owner != owner { event("inspectCanceled", ["owner": self.owner]) }
      cancelInspection()
      self.owner = owner
      inspecting = true
      hover = 0
      if let window {
        priorMouseMoved = window.acceptsMouseMovedEvents
        window.acceptsMouseMovedEvents = true
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
      }
      if monitor == nil {
        monitor = NSEvent.addLocalMonitorForEvents(matching: [
          .mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .keyDown,
        ]) { [weak self] event in
          guard let self else { return event }
          return self.handleEvent(event)
        }
      }
    }
    public func cancelInspection() {
      if inspecting {
        window?.acceptsMouseMovedEvents = priorMouseMoved
        NSCursor.arrow.set()
      }
      inspecting = false
      if !captured, let monitor {
        NSEvent.removeMonitor(monitor)
        self.monitor = nil
      }
    }
    /// Exposed for deterministic gesture testing without synthesizing OS input.
    public func handleEvent(_ input: NSEvent) -> NSEvent? {
      if captured {
        if input.type == .leftMouseUp {
          captured = false
          cancelInspection()
          return nil
        }
        if input.type == .leftMouseDragged { return nil }
        if input.type == .leftMouseDown { captured = false }
      }
      guard inspecting else {
        cancelInspection()
        return input
      }
      if input.type == .keyDown && input.keyCode == 53 {
        let owner = self.owner
        cancelInspection()
        highlight(0)
        event("inspectCanceled", ["owner": owner])
        return nil
      }
      guard input.window === window, let root = window?.contentView else { return input }
      let point = root.convert(input.locationInWindow, from: nil)
      guard root.bounds.contains(point) else { return input }
      if input.type == .mouseMoved || input.type == .leftMouseDown {
        let node = inspectPoint(point)
        highlight(node)
        if input.type == .mouseMoved {
          NSCursor.crosshair.set()
          if node != hover {
            hover = node
            event("hover", ["node": node, "owner": owner])
          }
        } else if node > 0 {
          captured = true
          cancelInspection()
          event("picked", ["node": node, "owner": owner])
          return nil
        }
      }
      return input
    }
    public func handle(_ method: String, _ params: [String: Any]) throws -> [String: Any] {
      precondition(Thread.isMainThread)
      let node = params["node"] as? Int ?? 0
      if node > 2, let logical = try object(node) as? SwiftUIInspectionNode,
        let result = try logical.handle(method, params, node: node) { return result }
      switch method {
      case "snapshot": return snapshot()
      case "event-listeners":
        return ["listeners": NativeEvents.listeners(try object(node))]
      case "layout":
        return try layout.inspect(view(node), id: { self.id($0) })
      case "layout-edit":
        return try layout.edit(view(node), params: params)
      case "layout-resolve":
        return ["constraint": try layout.resolve(params["key"] as? String ?? "", view: view(node))]
      case "layout-highlight":
        guard let root = window?.contentView else { throw InspectorError.invalid("Window closed") }
        try layout.highlight(
          params["constraint"] as? String ?? "", root: root, overlay: constraintOverlay)
        return [:]
      case "locate":
        guard let root = window?.contentView, let x = params["x"] as? Double,
          let y = params["y"] as? Double, x.isFinite, y.isFinite
        else { throw InspectorError.invalid("Invalid hit-test coordinates") }
        return ["node": inspectPoint(NSPoint(x: x, y: root.isFlipped ? y : root.bounds.height - y))]
      case "highlight":
        highlight(node)
        return [:]
      case "inspect":
        let owner = params["owner"] as? String ?? ""
        if params["enabled"] as? Bool == true {
          beginInspection(owner: owner)
        } else if owner == self.owner {
          cancelInspection()
          highlight(0)
        }
        return [:]
      case "style", "styles":
        let target = try view(node)
        let operations: [[String: Any]]
        if method == "style" {
          operations = [params]
        } else {
          guard let value = params["operations"] as? [[String: Any]], value.count <= 256 else {
            throw InspectorError.invalid("Invalid native style transaction")
          }
          operations = value
        }
        let editor = styleEditors[node] ?? NativeStyles(target)
        try editor.apply(operations)
        styleEditors[node] = editor
        return [:]
      case "attribute-state":
        return try attributeState(object(node), node: node, key: params["key"] as? String ?? "")
      case "attribute":
        try setAttribute(
          try object(node), node: node, key: params["key"] as? String ?? "",
          value: params["value"] as? String ?? ""
        )
        return [:]
      case "action":
        let object = try object(node)
        if let item = object as? NSMenuItem {
          guard params["key"] as? String == "press" else {
            throw InspectorError.invalid("Menu items support press actions only")
          }
          try press(item, node: node)
          return [:]
        }
        let view = try view(node)
        if params["key"] as? String == "focus" {
          window?.makeFirstResponder(view)
        } else if let button = view as? NSButton {
          button.performClick(nil)
        } else if let control = view as? NSControl {
          control.sendAction(control.action, to: control.target)
        } else {
          throw InspectorError.invalid("This element has no native action")
        }
        return [:]
      case "screenshot":
        guard let root = window?.contentView,
          let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds)
        else { throw InspectorError.invalid("Native screenshot unavailable") }
        root.cacheDisplay(in: root.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else {
          throw InspectorError.invalid("PNG encoding failed")
        }
        return ["data": data.base64EncodedString()]
      default: throw InspectorError.invalid("Unsupported native operation: \(method)")
      }
    }
  }
#endif
