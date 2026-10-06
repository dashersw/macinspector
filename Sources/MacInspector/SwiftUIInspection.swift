// SPDX-License-Identifier: MIT
import SwiftUI

#if canImport(AppKit)
  import AppKit
#else
  import UIKit
#endif

private struct InspectorRegistryKey: EnvironmentKey {
  static let defaultValue: SwiftUIInspectionRegistry? = nil
}
private struct InspectorParentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}
extension EnvironmentValues {
  fileprivate var inspectorRegistry: SwiftUIInspectionRegistry? {
    get { self[InspectorRegistryKey.self] }
    set { self[InspectorRegistryKey.self] = newValue }
  }
  fileprivate var inspectorParent: String? {
    get { self[InspectorParentKey.self] }
    set { self[InspectorParentKey.self] = newValue }
  }
}

extension View {
  /// Start one inspector for this window's registered SwiftUI hierarchy, in Debug builds only.
  /// Add MacInspector to your debug target; the modifier is inert when DEBUG is absent.
  public func macInspectorRoot(
    port: UInt16 = 0, onConnect: ((NativeInspector) -> Void)? = nil
  ) -> some View {
    #if DEBUG
      modifier(SwiftUIInspectorRoot(port: port, onConnect: onConnect))
    #else
      self
    #endif
  }

  /// Register a logical view. IDs must be unique and stable within the window.
  /// Properties must be the same bindings that your view uses to render.
  public func macInspector(
    id: String, tag: String? = nil, properties: [SwiftUIProperty] = [],
    action: SwiftUIAction? = nil
  ) -> some View {
    #if DEBUG
      modifier(
        SwiftUIInspectorModifier(
          identifier: id, tag: tag ?? Self.inspectorTypeName,
          properties: properties, action: action))
    #else
      self
    #endif
  }

  private static var inspectorTypeName: String {
    var name = String(reflecting: Self.self)
    while name.hasPrefix("SwiftUI.ModifiedContent<") {
      name = String(name.dropFirst("SwiftUI.ModifiedContent<".count))
    }
    return String(name.prefix { $0 != "<" && $0 != "," })
  }
}

private struct SwiftUIInspectorRoot: ViewModifier {
  @StateObject private var registry = SwiftUIInspectionRegistry()
  let port: UInt16
  let onConnect: ((NativeInspector) -> Void)?

  func body(content: Content) -> some View {
    content.environment(\.inspectorRegistry, registry)
      .overlay(SwiftUIRootProbe(registry: registry, port: port, onConnect: onConnect))
  }
}

private struct SwiftUIInspectorModifier: ViewModifier {
  @Environment(\.inspectorRegistry) private var registry
  @Environment(\.inspectorParent) private var parent
  let identifier: String
  let tag: String
  let properties: [SwiftUIProperty]
  let action: SwiftUIAction?

  func body(content: Content) -> some View {
    content.environment(\.inspectorParent, identifier)
      .background(
        SwiftUINodeProbe(
          registry: registry, identifier: identifier, tag: tag, parent: parent,
          properties: properties, action: action))
  }
}

final class SwiftUIInspectionRegistry: ObservableObject {
  private final class WeakRoot {
    weak var registry: SwiftUIInspectionRegistry?
    init(_ registry: SwiftUIInspectionRegistry) { self.registry = registry }
  }
  private static var roots: [WeakRoot] = []
  private(set) var nodes: [SwiftUIInspectionNode] = []
  weak var window: InspectorWindow?
  private weak var rootProbe: InspectorView?
  var overlayRoot: InspectorView? { rootProbe }
  private var inspector: NativeInspector?

  static func find(_ window: InspectorWindow) -> SwiftUIInspectionRegistry? {
    roots.removeAll { $0.registry == nil }
    return roots.compactMap(\.registry).first { $0.window === window }
  }

  func connect(
    _ window: InspectorWindow?, port: UInt16, probe: InspectorView,
    onConnect: ((NativeInspector) -> Void)? = nil
  ) {
    // SwiftUI can attach a replacement probe before dismantling its predecessor.
    // A late detach from the old probe must not close the new window's inspector.
    if window == nil && rootProbe !== probe { return }
    rootProbe = probe
    guard self.window !== window else { return }
    inspector?.stop()
    inspector = nil
    self.window = window
    guard let window else { return }
    Self.roots.removeAll { $0.registry == nil || $0.registry === self }
    Self.roots.append(WeakRoot(self))
    let instance = NativeInspector(window: window)
    do {
      let configured =
        ProcessInfo.processInfo.environment["MACINSPECTOR_NATIVE_PORT"]
        .flatMap(UInt16.init) ?? port
      try instance.start(port: configured)
      inspector = instance
      DispatchQueue.main.async { [weak self] in
        if self?.inspector === instance { onConnect?(instance) }
      }
    } catch {
      // Startup errors are visible without terminating the host application.
      NSLog("MacInspector SwiftUI startup failed: %@", String(describing: error))
    }
  }

  func register(_ node: SwiftUIInspectionNode) {
    if !contains(node) { nodes.append(node) }
    node.registry = self
  }

  func remove(_ node: SwiftUIInspectionNode) {
    nodes.removeAll { $0 === node }
    node.registry = nil
  }

  func contains(_ node: SwiftUIInspectionNode) -> Bool { nodes.contains { $0 === node } }

  func validate(_ node: SwiftUIInspectionNode) throws {
    guard node.attached, node.probe?.window === window else {
      throw InspectorError.invalid("Detached SwiftUI view")
    }
    guard nodes.filter({ $0.identifier == node.identifier && $0.attached }).count == 1 else {
      throw InspectorError.invalid("Duplicate SwiftUI identifier: \(node.identifier)")
    }
  }

  func snapshot(
    id: (NSObject) -> Int, measure: (InspectorView) -> CGRect
  ) -> (roots: [Int], nodes: [[String: Any]]) {
    let visible = nodes.filter { $0.probe?.window === window && $0.attached }
    var indexed: [String: SwiftUIInspectionNode] = [:]
    for node in visible where indexed[node.identifier] == nil { indexed[node.identifier] = node }
    func parent(_ node: SwiftUIInspectionNode) -> SwiftUIInspectionNode? {
      guard let key = node.parent, let value = indexed[key], value !== node else { return nil }
      guard visible.filter({ $0.identifier == key }).count == 1 else { return nil }
      return value
    }
    let roots = visible.filter { parent($0) == nil }.map { id($0) }
    let projected = visible.map { node -> [String: Any] in
      let nodeID = id(node)
      let bounds = measure(node.probe!)
      let valid = [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy { $0.isFinite }
      let box = valid ? bounds : .zero
      var attributes = ["id": node.identifier, "data-native-id": "\(nodeID)"]
      for property in node.properties where property.kind == .attribute {
        attributes[property.key] = property.read()
      }
      let text = node.properties.first { $0.kind == .text }?.read() ?? ""
      let input = node.tag == "SwiftUI.TextField" || node.tag == "SwiftUI.SecureField"
      return [
        "id": nodeID, "parent": parent(node).map { id($0) } ?? 2,
        "tag": node.tag, "text": input ? attributes["value"] ?? text : text,
        "textMode": input ? "value" : text.isEmpty ? "none" : "content", "textOwner": nodeID,
        "attributes": attributes, "children": visible.filter { parent($0) === node }.map { id($0) },
        "styles": node.styles, "listeners": node.listeners,
        "x": box.minX, "y": box.minY, "width": box.width, "height": box.height,
      ]
    }
    return (roots, projected)
  }

  func pick(_ point: CGPoint, in root: InspectorView) -> SwiftUIInspectionNode? {
    let attached = nodes.filter { $0.attached && $0.probe?.window === window }
    func depth(_ node: SwiftUIInspectionNode) -> Int {
      var current = node
      var seen = Set<String>()
      while let key = current.parent, seen.count < 128, seen.insert(key).inserted,
        let parent = attached.first(where: { $0.identifier == key })
      {
        current = parent
      }
      return seen.count
    }
    let ordered = attached.enumerated().sorted {
      let a = depth($0.element)
      let b = depth($1.element)
      return a == b ? $0.offset > $1.offset : a > b
    }
    return ordered.map(\.element).first { node in
      guard let probe = node.probe else { return false }
      let local = probe.convert(point, from: root)
      guard probe.bounds.contains(local) else { return false }
      var ancestor: InspectorView? = probe
      while let view = ancestor {
        #if canImport(AppKit)
          if view.isHidden || view.alphaValue < 0.01 { return false }
          if let clip = view as? NSClipView, !clip.bounds.contains(clip.convert(point, from: root))
          {
            return false
          }
        #else
          if view.isHidden || view.alpha < 0.01 { return false }
          if view.clipsToBounds && !view.bounds.contains(view.convert(point, from: root)) {
            return false
          }
        #endif
        ancestor = view.superview
      }
      return true
    }
  }
}

private final class ProbeCoordinator {
  var node: SwiftUIInspectionNode?
  func update(
    registry: SwiftUIInspectionRegistry?, probe: InspectorView, identifier: String,
    tag: String, parent: String?, properties: [SwiftUIProperty], action: SwiftUIAction?
  ) {
    if node?.identifier != identifier {
      if let node { node.registry?.remove(node) }
      node = SwiftUIInspectionNode(
        id: identifier, tag: tag, parent: parent, properties: properties, action: action)
    }
    guard let node else { return }
    if node.registry !== registry { node.registry?.remove(node) }
    node.tag = tag
    node.parent = parent
    node.properties = properties
    node.action = action
    node.probe = probe
    registry?.register(node)
  }
  func remove() {
    if let node { node.registry?.remove(node) }
    node = nil
  }
}

#if canImport(AppKit)
  private final class InspectorProbeView: NSView {
    var connected: ((NSWindow?) -> Void)?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      connected?(window)
    }
  }
  private struct SwiftUINodeProbe: NSViewRepresentable {
    var registry: SwiftUIInspectionRegistry?
    var identifier: String
    var tag: String
    var parent: String?
    var properties: [SwiftUIProperty]
    var action: SwiftUIAction?
    func makeCoordinator() -> ProbeCoordinator { ProbeCoordinator() }
    func makeNSView(context: Context) -> InspectorProbeView { InspectorProbeView() }
    func updateNSView(_ view: InspectorProbeView, context: Context) {
      context.coordinator.update(
        registry: registry, probe: view, identifier: identifier,
        tag: tag, parent: parent, properties: properties, action: action)
    }
    static func dismantleNSView(_ view: InspectorProbeView, coordinator: ProbeCoordinator) {
      coordinator.remove()
    }
  }
  private struct SwiftUIRootProbe: NSViewRepresentable {
    var registry: SwiftUIInspectionRegistry
    var port: UInt16
    var onConnect: ((NativeInspector) -> Void)?
    func makeNSView(context: Context) -> InspectorProbeView { InspectorProbeView() }
    func updateNSView(_ view: InspectorProbeView, context: Context) {
      view.connected = { [weak registry, weak view] window in
        if let view { registry?.connect(window, port: port, probe: view, onConnect: onConnect) }
      }
      if view.window != nil {
        registry.connect(view.window, port: port, probe: view, onConnect: onConnect)
      }
    }
  }
#else
  private final class InspectorProbeView: UIView {
    var connected: ((UIWindow?) -> Void)?
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
    override func didMoveToWindow() {
      super.didMoveToWindow()
      connected?(window)
    }
  }
  private struct SwiftUINodeProbe: UIViewRepresentable {
    var registry: SwiftUIInspectionRegistry?
    var identifier: String
    var tag: String
    var parent: String?
    var properties: [SwiftUIProperty]
    var action: SwiftUIAction?
    func makeCoordinator() -> ProbeCoordinator { ProbeCoordinator() }
    func makeUIView(context: Context) -> InspectorProbeView { InspectorProbeView() }
    func updateUIView(_ view: InspectorProbeView, context: Context) {
      context.coordinator.update(
        registry: registry, probe: view, identifier: identifier,
        tag: tag, parent: parent, properties: properties, action: action)
    }
    static func dismantleUIView(_ view: InspectorProbeView, coordinator: ProbeCoordinator) {
      coordinator.remove()
    }
  }
  private struct SwiftUIRootProbe: UIViewRepresentable {
    var registry: SwiftUIInspectionRegistry
    var port: UInt16
    var onConnect: ((NativeInspector) -> Void)?
    func makeUIView(context: Context) -> InspectorProbeView { InspectorProbeView() }
    func updateUIView(_ view: InspectorProbeView, context: Context) {
      view.connected = { [weak registry, weak view] window in
        if let view { registry?.connect(window, port: port, probe: view, onConnect: onConnect) }
      }
      if view.window != nil {
        registry.connect(view.window, port: port, probe: view, onConnect: onConnect)
      }
    }
  }
#endif

extension SwiftUIInspectionNode {
  func handle(_ method: String, _ params: [String: Any], node: Int) throws -> [String: Any]? {
    switch method {
    case "style", "styles":
      guard let operations = method == "style" ? [params] : params["operations"] as? [[String: Any]]
      else {
        throw InspectorError.invalid("Invalid SwiftUI style transaction")
      }
      try apply(operations)
      return [:]
    case "attribute-state":
      let property = try attribute(params["key"] as? String ?? "")
      return ["node": node, "key": property.key, "value": property.read()]
    case "attribute":
      try setAttribute(params["key"] as? String ?? "", value: params["value"] as? String ?? "")
      return [:]
    case "event-listeners": return ["listeners": listeners]
    case "action":
      guard params["key"] as? String == "press", let action,
        properties.first(where: { $0.key == "enabled" })?.read() != "false"
      else {
        throw InspectorError.invalid("Register an enabled SwiftUI action to activate this view")
      }
      try registry?.validate(self)
      MainActor.assumeIsolated { action.perform() }
      return [:]
    case "layout", "layout-edit", "layout-resolve":
      throw InspectorError.invalid(
        "SwiftUI uses its own layout system. Register width, height or spacing bindings and edit them in Styles."
      )
    default: return nil
    }
  }
}
