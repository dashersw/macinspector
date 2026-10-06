// SPDX-License-Identifier: MIT
import CoreFoundation

#if canImport(AppKit)
  import AppKit
  typealias LayoutView = NSView
  typealias LayoutGuide = NSLayoutGuide
  typealias LayoutPriority = NSLayoutConstraint.Priority
  typealias LayoutAxis = NSLayoutConstraint.Orientation
#else
  import UIKit
  typealias LayoutView = UIView
  typealias LayoutGuide = UILayoutGuide
  typealias LayoutPriority = UILayoutPriority
  typealias LayoutAxis = NSLayoutConstraint.Axis
#endif

#if canImport(AppKit)
  final class ConstraintOverlay: NSView {
    var rectangles: [NSRect] = []
    var label = ""
    override var isFlipped: Bool { superview?.isFlipped ?? false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
      NSColor.systemOrange.setStroke()
      for rect in rectangles {
        NSColor.systemOrange.withAlphaComponent(0.12).setFill()
        rect.fill()
        let path = NSBezierPath(rect: rect.insetBy(dx: 1, dy: 1))
        path.lineWidth = 2
        path.stroke()
      }
      if rectangles.count == 2 {
        let line = NSBezierPath()
        line.move(to: NSPoint(x: rectangles[0].midX, y: rectangles[0].midY))
        line.line(to: NSPoint(x: rectangles[1].midX, y: rectangles[1].midY))
        line.lineWidth = 2
        line.stroke()
      }
      (label as NSString).draw(
        at: NSPoint(x: 8, y: 8),
        withAttributes: [
          .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold),
          .foregroundColor: NSColor.systemOrange,
          .backgroundColor: NSColor.windowBackgroundColor,
        ])
    }
  }

#else
  final class ConstraintOverlay: UIView {
    var rectangles: [CGRect] = []
    var label = ""
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
    override func draw(_ rect: CGRect) {
      UIColor.systemOrange.setStroke()
      for bounds in rectangles {
        UIColor.systemOrange.withAlphaComponent(0.12).setFill()
        UIBezierPath(rect: bounds).fill()
        let path = UIBezierPath(rect: bounds.insetBy(dx: 1, dy: 1))
        path.lineWidth = 2
        path.stroke()
      }
      if rectangles.count == 2 {
        let line = UIBezierPath()
        line.move(to: CGPoint(x: rectangles[0].midX, y: rectangles[0].midY))
        line.addLine(to: CGPoint(x: rectangles[1].midX, y: rectangles[1].midY))
        line.lineWidth = 2
        line.stroke()
      }
      (label as NSString).draw(
        at: CGPoint(x: 8, y: 8),
        withAttributes: [
          .font: UIFont.monospacedSystemFont(ofSize: 12, weight: .semibold),
          .foregroundColor: UIColor.systemOrange,
          .backgroundColor: UIColor.systemBackground,
        ])
    }
  }

#endif

final class NativeLayout {
  private var constraints: [String: NSLayoutConstraint] = [:]
  private var identities: [ObjectIdentifier: String] = [:]

  func clear() {
    constraints.removeAll()
    identities.removeAll()
  }

  private func identifier(_ view: LayoutView) -> String? {
    #if canImport(AppKit)
      return view.identifier?.rawValue
    #else
      return view.accessibilityIdentifier
    #endif
  }

  private func guideName(_ guide: LayoutGuide) -> String {
    #if canImport(AppKit)
      return guide.identifier.rawValue
    #else
      return guide.identifier
    #endif
  }

  private func text(_ view: LayoutView) -> String? {
    #if canImport(AppKit)
      return (view as? NSButton)?.title ?? (view as? NSTextField)?.stringValue
    #else
      return (view as? UILabel)?.text ?? (view as? UIButton)?.currentTitle
        ?? (view as? UITextField)?.text
    #endif
  }

  private func relayout(_ view: LayoutView) {
    #if canImport(AppKit)
      view.window?.contentView?.layoutSubtreeIfNeeded()
    #else
      view.window?.layoutIfNeeded()
    #endif
  }

  private func owner(_ item: AnyObject?) -> LayoutView? {
    if let view = item as? LayoutView { return view }
    return (item as? LayoutGuide)?.owningView
  }

  private func path(_ view: LayoutView) -> String {
    if let identifier = identifier(view), !identifier.isEmpty { return "#" + identifier }
    var indices: [String] = []
    var current = view
    while let parent = current.superview {
      guard let index = parent.subviews.firstIndex(of: current) else { break }
      indices.insert(String(index), at: 0)
      current = parent
    }
    return NSStringFromClass(type(of: view)) + ":" + indices.joined(separator: "/")
  }

  private func itemKey(_ item: AnyObject?) -> String {
    guard let item else { return "nil" }
    if let guide = item as? LayoutGuide {
      return (guide.owningView.map(path) ?? "detached") + "/guide:" + guideName(guide)
    }
    return owner(item).map(path) ?? String(describing: type(of: item))
  }

  private func key(_ c: NSLayoutConstraint) -> String {
    if let identifier = c.identifier, !identifier.isEmpty {
      if identifier == "MacInspector.width" || identifier == "MacInspector.height" {
        return "id:" + identifier + "|" + itemKey(c.firstItem)
      }
      return "id:" + identifier
    }
    return [
      itemKey(c.firstItem), String(c.firstAttribute.rawValue),
      String(c.relation.rawValue), itemKey(c.secondItem), String(c.secondAttribute.rawValue),
      String(Double(c.multiplier)),
    ].joined(separator: "|")
  }

  private func remember(_ constraint: NSLayoutConstraint) throws -> String {
    let object = ObjectIdentifier(constraint)
    if let id = identities[object] { return id }
    guard constraints.count < 4096 else {
      throw InspectorError.invalid("Constraint limit exceeded")
    }
    let id = UUID().uuidString
    identities[object] = id
    constraints[id] = constraint
    return id
  }

  private func relevant(_ view: LayoutView) -> [NSLayoutConstraint] {
    var result =
      view.constraintsAffectingLayout(for: .horizontal)
      + view.constraintsAffectingLayout(for: .vertical)
    var ancestor: LayoutView? = view
    while let current = ancestor {
      result += current.constraints.filter {
        owner($0.firstItem) === view || owner($0.secondItem) === view
      }
      ancestor = current.superview
    }
    result += constraints.values.filter {
      owner($0.firstItem) === view || owner($0.secondItem) === view
    }
    var seen = Set<ObjectIdentifier>()
    return result.filter { seen.insert(ObjectIdentifier($0)).inserted }
  }

  private func attribute(_ value: NSLayoutConstraint.Attribute) -> String {
    switch value {
    case .left: return "left"
    case .right: return "right"
    case .top: return "top"
    case .bottom: return "bottom"
    case .leading: return "leading"
    case .trailing: return "trailing"
    case .width: return "width"
    case .height: return "height"
    case .centerX: return "centerX"
    case .centerY: return "centerY"
    case .lastBaseline: return "lastBaseline"
    case .firstBaseline: return "firstBaseline"
    case .notAnAttribute: return "none"
    #if canImport(UIKit)
      case .leftMargin: return "leftMargin"
      case .rightMargin: return "rightMargin"
      case .topMargin: return "topMargin"
      case .bottomMargin: return "bottomMargin"
      case .leadingMargin: return "leadingMargin"
      case .trailingMargin: return "trailingMargin"
      case .centerXWithinMargins: return "centerXWithinMargins"
      case .centerYWithinMargins: return "centerYWithinMargins"
    #endif
    @unknown default: return "native attribute \(value.rawValue)"
    }
  }

  private func state(_ c: NSLayoutConstraint) -> [String: Any] {
    ["constant": c.constant, "priority": c.priority.rawValue, "active": c.isActive]
  }

  private func display(_ item: AnyObject?, id: (LayoutView) -> Int) -> String {
    guard let item else { return "Constant" }
    guard let view = owner(item) else { return String(describing: type(of: item)) }
    let name = NSStringFromClass(type(of: view))
    let text = text(view)
    let identifier = identifier(view)
    let label: String
    if let identifier, !identifier.isEmpty {
      label = "\(name) #\(identifier)"
    } else if let text, !text.isEmpty {
      label = "\(name) “\(text.prefix(48))\(text.count > 48 ? "…" : "")”"
    } else {
      label = "\(name) · \(id(view))"
    }
    if let guide = item as? LayoutGuide {
      return label + " / "
        + (guideName(guide).isEmpty ? "Layout guide" : guideName(guide))
    }
    return label
  }

  func inspect(_ view: LayoutView, id: (LayoutView) -> Int) throws -> [String: Any] {
    let intrinsic = view.intrinsicContentSize
    let items = try relevant(view).map { c -> [String: Any] in
      var result = state(c)
      result["id"] = try remember(c)
      result["key"] = key(c)
      result["identifier"] = c.identifier ?? ""
      result["first"] = owner(c.firstItem).map(id) ?? 0
      result["second"] = owner(c.secondItem).map(id) ?? 0
      result["firstLabel"] = display(c.firstItem, id: id)
      result["secondLabel"] = display(c.secondItem, id: id)
      for (name, item) in [("firstGuide", c.firstItem), ("secondGuide", c.secondItem)] {
        if let guide = item as? LayoutGuide {
          result[name] =
            guideName(guide).isEmpty ? "Layout guide" : guideName(guide)
        }
      }
      result["direct"] = owner(c.firstItem) === view || owner(c.secondItem) === view
      result["firstAttribute"] = attribute(c.firstAttribute)
      result["secondAttribute"] = attribute(c.secondAttribute)
      result["relation"] = c.relation == .equal ? "=" : c.relation == .lessThanOrEqual ? "≤" : "≥"
      result["multiplier"] = c.multiplier
      return result
    }
    return [
      "name": display(view, id: id),
      "constraints": items,
      "intrinsic": ["width": intrinsic.width, "height": intrinsic.height],
      "ambiguous": view.hasAmbiguousLayout,
      "translatesAutoresizingMask": view.translatesAutoresizingMaskIntoConstraints,
      "huggingHorizontal": view.contentHuggingPriority(for: .horizontal).rawValue,
      "huggingVertical": view.contentHuggingPriority(for: .vertical).rawValue,
      "compressionHorizontal": view.contentCompressionResistancePriority(for: .horizontal).rawValue,
      "compressionVertical": view.contentCompressionResistancePriority(for: .vertical).rawValue,
    ]
  }

  private func number(_ values: [String: Any], _ name: String, _ range: ClosedRange<Double>) throws
    -> Double?
  {
    guard let raw = values[name] else { return nil }
    guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
      value.doubleValue.isFinite, range.contains(value.doubleValue)
    else { throw InspectorError.invalid("Invalid layout \(name)") }
    return value.doubleValue
  }

  func edit(_ view: LayoutView, params: [String: Any]) throws -> [String: Any] {
    if let id = params["constraint"] as? String {
      guard let constraint = constraints[id], relevant(view).contains(where: { $0 === constraint }),
        owner(constraint.firstItem)?.window === view.window
      else { throw InspectorError.invalid("Stale or unrelated constraint") }
      let constant = try number(params, "constant", -1_000_000...1_000_000)
      let priority = try number(params, "priority", 1...1000)
      if let active = params["active"] {
        guard let value = active as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else {
          throw InspectorError.invalid("Invalid layout active state")
        }
      }
      let wasActive = constraint.isActive
      if priority != nil && wasActive { constraint.isActive = false }
      if let constant { constraint.constant = constant }
      if let priority { constraint.priority = LayoutPriority(Float(priority)) }
      constraint.isActive = params["active"] as? Bool ?? wasActive
      relayout(view)
      return state(constraint)
    }
    let setters: [(String, LayoutAxis, Bool)] = [
      ("huggingHorizontal", .horizontal, false), ("huggingVertical", .vertical, false),
      ("compressionHorizontal", .horizontal, true), ("compressionVertical", .vertical, true),
    ]
    let values = try setters.map { try number(params, $0.0, 1...1000) }
    for (index, setter) in setters.enumerated() {
      guard let value = values[index] else { continue }
      let priority = LayoutPriority(Float(value))
      if setter.2 {
        view.setContentCompressionResistancePriority(priority, for: setter.1)
      } else {
        view.setContentHuggingPriority(priority, for: setter.1)
      }
    }
    relayout(view)
    return [:]
  }

  func resolve(_ key: String, view: LayoutView) throws -> String {
    let matches = relevant(view).filter { self.key($0) == key }
    guard matches.count == 1 else {
      throw InspectorError.invalid(
        "Constraint is missing or ambiguous: \(key). Assign a unique constraint identifier.")
    }
    return try remember(matches[0])
  }

  func highlight(_ id: String, root: LayoutView, overlay: ConstraintOverlay) throws {
    overlay.removeFromSuperview()
    guard !id.isEmpty else { return }
    guard let constraint = constraints[id], owner(constraint.firstItem)?.window === root.window
    else {
      throw InspectorError.invalid("Stale constraint")
    }
    overlay.frame = root.bounds
    #if canImport(AppKit)
      overlay.autoresizingMask = [.width, .height]
    #else
      overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    #endif
    overlay.rectangles = [owner(constraint.firstItem), owner(constraint.secondItem)].compactMap {
      view in
      view.map { root.convert($0.bounds, from: $0) }
    }
    overlay.label =
      "\(attribute(constraint.firstAttribute)) \(constraint.relation == .equal ? "=" : constraint.relation == .lessThanOrEqual ? "≤" : "≥") \(constraint.constant) @ \(constraint.priority.rawValue)"
    #if canImport(AppKit)
      root.addSubview(overlay, positioned: .above, relativeTo: nil)
      overlay.needsDisplay = true
    #else
      overlay.backgroundColor = .clear
      root.addSubview(overlay)
      overlay.setNeedsDisplay()
    #endif
  }
}
