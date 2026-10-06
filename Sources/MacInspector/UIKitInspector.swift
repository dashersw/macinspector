// SPDX-License-Identifier: MIT
#if canImport(UIKit)
  import UIKit

  private final class UIKitOutline: UIView {
    var picking = false
    var pointer: ((CGPoint?, Bool) -> Void)?
    override init(frame: CGRect) {
      super.init(frame: frame)
      addGestureRecognizer(UIHoverGestureRecognizer(target: self, action: #selector(hovered(_:))))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    @objc private func hovered(_ gesture: UIHoverGestureRecognizer) {
      guard picking else { return }
      switch gesture.state {
      case .began, .changed: pointer?(gesture.location(in: self), false)
      case .ended, .cancelled: pointer?(nil, false)
      default: break
      }
    }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
      picking && bounds.contains(point) ? self : nil
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
      if let point = touches.first?.location(in: self) { pointer?(point, false) }
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
      if let point = touches.first?.location(in: self) { pointer?(point, false) }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
      if let point = touches.first?.location(in: self) { pointer?(point, true) }
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
      pointer?(nil, false)
    }
  }

  private struct UIKitKey: Hashable {
    let object: ObjectIdentifier
    let parent: Int
  }

  private final class UIKitReference {
    weak var object: NSObject?
    let id: Int
    init(_ object: NSObject, id: Int) {
      self.object = object
      self.id = id
    }
  }

  /// Inspect an actual UIKit window. Initialize and operate on the main thread.
  public final class NativeInspector {
    private weak var window: UIWindow?
    private let server = NativeServer()
    private var references: [UIKitKey: UIKitReference] = [:]
    private var byID: [Int: UIKitReference] = [:]
    private var attached = Set<Int>()
    private var nextID = 3
    var styleEditors: [Int: NativeStyles] = [:]
    let layout = NativeLayout()
    private let constraintOverlay = ConstraintOverlay()
    private var outline = UIKitOutline()
    private var picker = UIKitOutline()
    private var owner = ""
    private var outlined = 0
    private var hovered = 0
    public var emit: ((String, [String: Any]) -> Void)?
    public var connectionError: Error? { server.connectionError }

    public init(window: UIWindow) {
      self.window = window
      outline.isUserInteractionEnabled = false
      outline.backgroundColor = UIColor.systemBlue.withAlphaComponent(0.15)
      outline.layer.borderWidth = 2
      outline.layer.borderColor = UIColor.systemBlue.cgColor
      picker.backgroundColor = .clear
      picker.pointer = { [weak self] point, selected in
        self?.inspectPointer(point, selected: selected)
      }
    }

    public func start(port: UInt16 = 0, token: String? = nil) throws {
      try server.start(
        port: port, token: token, title: title,
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

    public func stop() {
      cancelInspection()
      highlight(0)
      constraintOverlay.removeFromSuperview()
      layout.clear()
      server.stop()
    }

    private var title: String {
      Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? Bundle.main
        .bundleIdentifier ?? "UIKit app"
    }
    private func event(_ method: String, _ params: [String: Any]) {
      emit?(method, params)
      server.emit(method, params)
    }
    func relayout() { window?.layoutIfNeeded() }
    func id(_ object: NSObject, parent: Int = 0) -> Int {
      let key = UIKitKey(object: ObjectIdentifier(object), parent: parent)
      if let reference = references[key], reference.object === object { return reference.id }
      let reference = UIKitReference(object, id: nextID)
      nextID += 1
      references[key] = reference
      byID[reference.id] = reference
      return reference.id
    }
    func object(_ node: Int) throws -> NSObject {
      guard let object = byID[node]?.object else {
        throw InspectorError.invalid("Stale UIKit element")
      }
      if let logical = object as? SwiftUIInspectionNode {
        try logical.registry?.validate(logical)
        guard logical.attached, logical.probe?.window === window else {
          throw InspectorError.invalid("Detached SwiftUI view")
        }
        return object
      }
      if let view = object as? UIView {
        guard view === window || view.window === window else {
          throw InspectorError.invalid("Detached UIKit view")
        }
      } else if !attached.contains(node) {
        throw InspectorError.invalid("Detached UIKit menu")
      }
      return object
    }
    func view(_ node: Int) throws -> UIView {
      let target = try object(node)
      if let logical = target as? SwiftUIInspectionNode, let probe = logical.probe { return probe }
      guard let view = target as? UIView else {
        throw InspectorError.invalid("This UIKit object has no view appearance")
      }
      return view
    }

    func snapshot() -> [String: Any] {
      guard let window else { return [:] }
      relayout()
      references = references.filter { $0.value.object != nil }
      byID = byID.filter { $0.value.object != nil }
      styleEditors = styleEditors.filter { (byID[$0.key]?.object as? UIView)?.window === window }
      attached.removeAll()
      var nodes: [[String: Any]] = [
        [
          "id": 2, "parent": 1, "tag": "UIApplication", "text": "", "attributes": ["title": title],
          "children": [id(window)], "x": 0, "y": 0, "width": window.bounds.width,
          "height": window.bounds.height, "styles": [:],
        ]
      ]
      func menu(_ element: UIMenuElement, parent: Int) {
        let node = id(element, parent: parent)
        attached.insert(node)
        let children = (element as? UIMenu)?.children ?? []
        var attrs = ["data-native-id": "\(node)", "title": element.title]
        if let action = element as? UIAction {
          attrs["id"] = action.identifier.rawValue
          attrs["enabled"] = "\(!action.attributes.contains(.disabled))"
          attrs["hidden"] = "\(action.attributes.contains(.hidden))"
          attrs["checked"] =
            action.state == .on ? "true" : action.state == .mixed ? "mixed" : "false"
          attrs["action-inspection"] = "closure metadata only"
        }
        nodes.append([
          "id": node, "parent": parent, "tag": NSStringFromClass(type(of: element)),
          "text": element.title, "attributes": attrs,
          "children": children.map { id($0, parent: node) }, "x": 0,
          "y": 0, "width": 0, "height": 0, "styles": [:],
        ])
        for child in children { menu(child, parent: node) }
      }
      func visit(_ view: UIView, parent: Int) {
        let node = id(view)
        attached.insert(node)
        let children = view.subviews.filter {
          $0 !== outline && $0 !== picker && $0 !== constraintOverlay
        }
        var attrs = ["data-native-id": "\(node)"]
        if let identifier = view.accessibilityIdentifier { attrs["id"] = identifier }
        if let control = view as? UIControl { attrs["enabled"] = "\(control.isEnabled)" }
        var text = ""
        var textMode = "none"
        var textOwner = node
        if let label = view as? UILabel {
          text = label.text ?? ""
          textMode = "content"
          if let button = label.superview as? UIButton, button.titleLabel === label {
            textOwner = id(button)
          }
          attrs["text"] = text
        }
        if let field = view as? UITextField {
          text = field.text ?? ""
          textMode = "value"
          attrs["value"] = text
          attrs["placeholder"] = field.placeholder ?? ""
        }
        if let field = view as? UITextView {
          text = field.text ?? ""
          textMode = "content"
          attrs["value"] = text
        }
        if let button = view as? UIButton {
          text = button.currentTitle ?? ""
          textMode = "content"
          attrs["title"] = text
          attrs["checked"] = "\(button.isSelected)"
        }
        if let toggle = view as? UISwitch { attrs["checked"] = "\(toggle.isOn)" }
        if let slider = view as? UISlider { attrs["value"] = "\(slider.value)" }
        if let stepper = view as? UIStepper { attrs["value"] = "\(stepper.value)" }
        if let segment = view as? UISegmentedControl {
          attrs["value"] = "\(segment.selectedSegmentIndex)"
        }
        if let progress = view as? UIProgressView { attrs["value"] = "\(progress.progress)" }
        let box = view.convert(view.bounds, to: window)
        let valid = [box.minX, box.minY, box.width, box.height].allSatisfy { $0.isFinite }
        let bounds = valid ? box : .zero
        if !valid { attrs["layout-valid"] = "false" }
        let nativeMenu = (view as? UIButton)?.menu
        nodes.append([
          "id": node, "parent": parent, "tag": NSStringFromClass(type(of: view)), "text": text,
          "textMode": textMode,
          "textOwner": textOwner,
          "attributes": attrs,
          "children": children.map { id($0) } + (nativeMenu.map { [id($0, parent: node)] } ?? []),
          "listeners": NativeEvents.listeners(view), "x": bounds.minX, "y": bounds.minY,
          "width": bounds.width, "height": bounds.height,
          "styles": styleEditors[node]?.snapshot() ?? NativeStyles.snapshot(view),
        ])
        for child in children { visit(child, parent: node) }
        if let nativeMenu { menu(nativeMenu, parent: node) }
      }
      let swiftUI = SwiftUIInspectionRegistry.find(window)
      if let swiftUI {
        let logical = swiftUI.snapshot(id: { self.id($0) }, measure: { $0.convert($0.bounds, to: window) })
        nodes[0]["children"] = logical.roots
        nodes += logical.nodes
      } else {
        visit(window, parent: 2)
      }
      if outlined != 0 { highlight(outlined) }
      return [
        "root": 2, "nodes": nodes, "width": window.bounds.width, "height": window.bounds.height,
        "title": title, "backend": "uikit", "pid": Int(ProcessInfo.processInfo.processIdentifier),
        "bundleId": Bundle.main.bundleIdentifier ?? "", "session": server.record.session,
        "capabilities": [
          "styles", "attributes", "attribute-state", "pick", "screenshot", "actions", "layout",
          "event-listeners",
        ].filter { $0 != "layout" || swiftUI == nil } + (swiftUI == nil ? [] : ["swiftui"]), "styleProperties": swiftUI == nil ? NativeStyles.properties :
          Array(Set(nodes.flatMap { Array(($0["styles"] as? [String: String] ?? [:]).keys) } + ["background"])).sorted(),
      ]
    }

    func attributeState(_ object: NSObject, node: Int, key: String) throws -> [String: Any] {
      if let logical = object as? SwiftUIInspectionNode {
        let property = try logical.attribute(key)
        return ["node": node, "key": property.key, "value": property.read()]
      }
      let view = try view(node)
      var property = key
      let value: String
      switch key {
      case "id": value = view.accessibilityIdentifier ?? ""
      case "value", "text", "title":
        if let label = view as? UILabel {
          property = "text"
          value = label.text ?? ""
        } else if let field = view as? UITextField {
          property = "value"
          value = field.text ?? ""
        } else if let text = view as? UITextView {
          property = "value"
          value = text.text ?? ""
        } else if let button = view as? UIButton {
          property = "title"
          value = button.currentTitle ?? ""
        } else if let slider = view as? UISlider {
          value = "\(slider.value)"
        } else if let stepper = view as? UIStepper {
          value = "\(stepper.value)"
        } else if let segment = view as? UISegmentedControl {
          value = "\(segment.selectedSegmentIndex)"
        } else if let progress = view as? UIProgressView {
          value = "\(progress.progress)"
        } else {
          throw InspectorError.invalid("This UIKit view has no editable value")
        }
      case "enabled":
        guard let control = view as? UIControl else {
          throw InspectorError.invalid("Not a UIControl")
        }
        value = "\(control.isEnabled)"
      case "checked":
        if let toggle = view as? UISwitch {
          value = "\(toggle.isOn)"
        } else if let control = view as? UIControl {
          value = "\(control.isSelected)"
        } else {
          throw InspectorError.invalid("This UIKit view has no checked state")
        }
      default: throw InspectorError.invalid("Unsupported UIKit attribute")
      }
      return ["node": node, "key": property, "value": value]
    }

    func setAttribute(_ object: NSObject, node: Int, key: String, value: String) throws {
      if let logical = object as? SwiftUIInspectionNode { return try logical.setAttribute(key, value: value) }
      let view = try view(node)
      switch key {
      case "id": view.accessibilityIdentifier = value.isEmpty ? nil : value
      case "text", "title", "value":
        if let label = view as? UILabel {
          label.text = value
        } else if let field = view as? UITextField {
          field.text = value
        } else if let text = view as? UITextView {
          text.text = value
        } else if let button = view as? UIButton {
          button.setTitle(value, for: .normal)
        } else if let slider = view as? UISlider, let number = Float(value), number.isFinite,
          (slider.minimumValue...slider.maximumValue).contains(number)
        {
          slider.value = number
        } else if let stepper = view as? UIStepper, let number = Double(value), number.isFinite,
          (stepper.minimumValue...stepper.maximumValue).contains(number)
        {
          stepper.value = number
        } else if let segment = view as? UISegmentedControl, let number = Int(value), number >= -1,
          number < segment.numberOfSegments
        {
          segment.selectedSegmentIndex = number
        } else if let progress = view as? UIProgressView, let number = Float(value),
          number.isFinite, (0...1).contains(number)
        {
          progress.progress = number
        } else {
          throw InspectorError.invalid("Unsupported or invalid UIKit value")
        }
      case "enabled", "checked":
        guard ["true", "false"].contains(value), let control = view as? UIControl else {
          throw InspectorError.invalid("Expected UIControl and true/false")
        }
        if key == "enabled" {
          control.isEnabled = value == "true"
        } else if let toggle = control as? UISwitch {
          toggle.isOn = value == "true"
        } else {
          control.isSelected = value == "true"
        }
      default: throw InspectorError.invalid("Read-only UIKit attribute")
      }
      relayout()
    }

    private func inspectPoint(_ point: CGPoint) -> Int {
      guard let window, window.bounds.contains(point) else { return 0 }
      if let registry = SwiftUIInspectionRegistry.find(window) {
        return registry.pick(point, in: window).map { id($0) } ?? 0
      }
      // Inspection follows visible geometry, including labels and disabled
      // controls that UIKit's touch dispatch deliberately skips. Keep the
      // picker installed throughout the gesture so it receives the touch end.
      func visit(_ view: UIView, depth: Int) -> UIView? {
        guard depth < 64, view !== outline, view !== picker, view !== constraintOverlay,
          !view.isHidden, view.alpha >= 0.01
        else { return nil }
        let local = view.convert(point, from: window)
        let inside = view.bounds.contains(local)
        if inside || !view.clipsToBounds {
          let children = view.subviews.enumerated().sorted {
            let left = $0.element.layer.zPosition
            let right = $1.element.layer.zPosition
            return left == right ? $0.offset > $1.offset : left > right
          }
          for child in children {
            if let hit = visit(child.element, depth: depth + 1) { return hit }
          }
        }
        return inside ? view : nil
      }
      return visit(window, depth: 0).map { id($0) } ?? 0
    }
    private func inspectPointer(_ point: CGPoint?, selected: Bool = false) {
      guard picker.picking else { return }
      let node = point.map { inspectPoint($0) } ?? 0
      highlight(node)
      if selected || hovered != node {
        hovered = node
        event(selected ? "picked" : "hover", ["node": node, "owner": owner])
      }
      if selected { cancelInspection() }
    }
    public func highlight(_ node: Int) {
      guard let window, node > 2, let view = try? view(node) else {
        outline.removeFromSuperview()
        outlined = 0
        return
      }
      outline.frame = view.convert(view.bounds, to: window)
      if outline.superview !== window { window.addSubview(outline) }
      if picker.picking { window.bringSubviewToFront(picker) }
      outlined = node
    }
    public func beginInspection(owner: String) {
      if picker.picking && self.owner != owner { event("inspectCanceled", ["owner": self.owner]) }
      self.owner = owner
      hovered = 0
      guard let window else { return }
      picker.frame = window.bounds
      picker.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      picker.picking = true
      window.addSubview(picker)
    }
    public func cancelInspection() {
      picker.picking = false
      picker.removeFromSuperview()
    }

    public func handle(_ method: String, _ params: [String: Any]) throws -> [String: Any] {
      precondition(Thread.isMainThread)
      let node = params["node"] as? Int ?? 0
      if node > 2, let logical = try object(node) as? SwiftUIInspectionNode,
        let result = try logical.handle(method, params, node: node) { return result }
      switch method {
      case "snapshot":
        let result = snapshot()
        guard let nodes = result["nodes"] as? [[String: Any]], nodes.count <= 4096 else {
          throw InspectorError.invalid("UIKit tree exceeds inspection limit")
        }
        return result
      case "event-listeners": return ["listeners": NativeEvents.listeners(try object(node))]
      case "layout": return try layout.inspect(view(node), id: { self.id($0) })
      case "layout-edit": return try layout.edit(view(node), params: params)
      case "layout-resolve":
        return ["constraint": try layout.resolve(params["key"] as? String ?? "", view: view(node))]
      case "layout-highlight":
        guard let window else { throw InspectorError.invalid("Window closed") }
        try layout.highlight(
          params["constraint"] as? String ?? "", root: window, overlay: constraintOverlay)
        return [:]
      case "highlight":
        highlight(node)
        return [:]
      case "locate":
        guard let x = params["x"] as? Double, let y = params["y"] as? Double, x.isFinite, y.isFinite
        else { throw InspectorError.invalid("Invalid UIKit coordinates") }
        return ["node": inspectPoint(CGPoint(x: x, y: y))]
      case "hover":
        // Simulator host pointer updates must not revive a completed gesture
        // or take over a picker belonging to another DevTools connection.
        guard picker.picking, params["owner"] as? String == owner else { return [:] }
        if params["inside"] as? Bool == false {
          inspectPointer(nil)
        } else {
          guard let x = params["x"] as? Double, let y = params["y"] as? Double,
            x.isFinite, y.isFinite
          else { throw InspectorError.invalid("Invalid UIKit pointer coordinates") }
          inspectPointer(CGPoint(x: x, y: y))
        }
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
        guard
          let operations = method == "style" ? [params] : params["operations"] as? [[String: Any]],
          operations.count <= 256
        else { throw InspectorError.invalid("Invalid UIKit style transaction") }
        let editor = styleEditors[node] ?? NativeStyles(target)
        try editor.apply(operations)
        styleEditors[node] = editor
        return [:]
      case "attribute-state":
        return try attributeState(object(node), node: node, key: params["key"] as? String ?? "")
      case "attribute":
        try setAttribute(
          object(node), node: node, key: params["key"] as? String ?? "",
          value: params["value"] as? String ?? "")
        return [:]
      case "action":
        let target = try view(node)
        if params["key"] as? String == "focus" {
          target.becomeFirstResponder()
          return [:]
        }
        guard let control = target as? UIControl, control.isEnabled, !control.isHidden,
          control.window != nil
        else { throw InspectorError.invalid("This UIKit control cannot be activated") }
        if control is UIButton {
          control.sendActions(
            for: control.allControlEvents.contains(.primaryActionTriggered)
              ? .primaryActionTriggered : .touchUpInside)
        } else {
          control.sendActions(for: .valueChanged)
        }
        return [:]
      case "screenshot":
        guard let window else { throw InspectorError.invalid("Window closed") }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
          window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        guard let data = image.pngData() else {
          throw InspectorError.invalid("UIKit screenshot unavailable")
        }
        return ["data": data.base64EncodedString()]
      default: throw InspectorError.invalid("Unsupported UIKit operation: \(method)")
      }
    }
  }
#endif
