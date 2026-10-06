// SPDX-License-Identifier: MIT
#if canImport(AppKit)
  import AppKit
#else
  import UIKit
#endif

/// Size declarations use the same anchors and priorities as native app code.
/// Only direct constant-size constraints are replaced; relationships remain active.
final class NativeDimensions {
  private struct Override {
    let constraint: NSLayoutConstraint
    let suspended: [NSLayoutConstraint]
  }

  private weak var view: LayoutView?
  private var overrides: [String: Override] = [:]
  private var owned: [String: NSLayoutConstraint] = [:]

  init(_ view: LayoutView) { self.view = view }

  func checkpoint(_ key: String) -> () -> Void {
    let previous = overrides[key]
    let constant = previous?.constraint.constant
    let priority = previous?.constraint.priority
    let active = previous?.constraint.isActive ?? false
    return { [weak self] in
      guard let self else { return }
      self.reset(key)
      if let previous, let constant, let priority {
        NSLayoutConstraint.deactivate(previous.suspended)
        previous.constraint.constant = constant
        previous.constraint.priority = priority
        previous.constraint.isActive = active
        self.overrides[key] = previous
      }
    }
  }

  private func reset(_ key: String) {
    guard let previous = overrides.removeValue(forKey: key) else { return }
    previous.constraint.isActive = false
    NSLayoutConstraint.activate(previous.suspended)
  }

  func set(_ key: String, value: String) throws {
    if value == "auto" {
      reset(key)
      return
    }
    let text = value.hasSuffix("px") ? String(value.dropLast(2)) : value
    guard let number = Double(text), number.isFinite, (0...10000).contains(number) else {
      throw InspectorError.invalid("Use auto or a finite size from 0 to 10000 native points (px)")
    }
    guard let view, view.window != nil else {
      throw InspectorError.invalid("Size edits require a view attached to a window")
    }
    guard !view.translatesAutoresizingMaskIntoConstraints else {
      throw InspectorError.invalid(
        "This view uses autoresizing masks; enable Auto Layout in native code before editing its size"
      )
    }
    if let existing = overrides[key] {
      existing.constraint.constant = CGFloat(number)
      return
    }
    let attribute: NSLayoutConstraint.Attribute = key == "width" ? .width : .height
    let suspended = view.constraints.filter {
      $0.isActive && $0.firstItem === view && $0.firstAttribute == attribute
        && $0.secondItem == nil && $0.relation == .equal
    }
    let anchor = key == "width" ? view.widthAnchor : view.heightAnchor
    let constraint = owned[key] ?? anchor.constraint(equalToConstant: CGFloat(number))
    constraint.constant = CGFloat(number)
    constraint.identifier = "MacInspector.\(key)"
    constraint.priority = LayoutPriority(rawValue: 999)
    NSLayoutConstraint.deactivate(suspended)
    constraint.isActive = true
    owned[key] = constraint
    overrides[key] = Override(constraint: constraint, suspended: suspended)
  }

  func validate() throws {
    guard let view else { return }
    for (key, value) in overrides where value.constraint.isActive {
      let actual = key == "width" ? view.bounds.width : view.bounds.height
      guard actual.isFinite, abs(actual - value.constraint.constant) <= 0.5 else {
        throw InspectorError.invalid(
          "Auto Layout cannot apply \(key): \(value.constraint.constant)px; resolved size is \(actual)px. Inspect required constraints in Native Layout"
        )
      }
    }
  }

  func snapshot() -> [String: String] {
    overrides.reduce(into: [:]) { values, entry in
      if entry.value.constraint.isActive {
        values[entry.key] = "\(entry.value.constraint.constant)px"
      }
    }
  }
}
