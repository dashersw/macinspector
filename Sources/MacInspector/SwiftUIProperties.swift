// SPDX-License-Identifier: MIT
import SwiftUI

#if canImport(AppKit)
  import AppKit
  typealias InspectorView = NSView
  typealias InspectorWindow = NSWindow
#else
  import UIKit
  typealias InspectorView = UIView
  typealias InspectorWindow = UIWindow
#endif

/// A public binding used by the view itself. MacInspector never rewrites SwiftUI internals.
public struct SwiftUIProperty {
  enum Kind { case style, attribute, text }
  let key: String
  let kind: Kind
  let read: () -> String
  let write: ((String) throws -> Void)?
  let capture: () -> (() -> Void)

  private static func bound<T>(
    _ key: String, kind: Kind, binding: Binding<T>,
    read: @escaping (T) -> String, parse: @escaping (String) throws -> T
  ) -> Self {
    Self(
      key: key, kind: kind, read: { read(binding.wrappedValue) },
      write: { binding.wrappedValue = try parse($0) },
      capture: {
        let value = binding.wrappedValue
        return { binding.wrappedValue = value }
      })
  }

  public static func text(_ binding: Binding<String>) -> Self {
    bound("text", kind: .text, binding: binding, read: { $0 }, parse: { $0 })
  }

  /// Display-only text, for labels derived from state. Editing is explicitly rejected.
  public static func text(_ value: String) -> Self {
    Self(key: "text", kind: .text, read: { value }, write: nil, capture: { {} })
  }

  public static func value(_ binding: Binding<String>, choices: [String]? = nil) -> Self {
    bound(
      "value", kind: .attribute, binding: binding, read: { $0 },
      parse: {
        guard choices == nil || choices!.contains($0) else {
          throw InspectorError.invalid("Choose one of: \(choices!.joined(separator: ", "))")
        }
        return $0
      })
  }

  public static func value(_ binding: Binding<Int>, range: ClosedRange<Int>) -> Self {
    bound(
      "value", kind: .attribute, binding: binding, read: String.init,
      parse: {
        guard let value = Int($0), range.contains(value) else {
          throw InspectorError.invalid("Expected an integer in \(range)")
        }
        return value
      })
  }

  public static func value<T: BinaryFloatingPoint>(
    _ binding: Binding<T>, range: ClosedRange<Double>
  ) -> Self {
    bound(
      "value", kind: .attribute, binding: binding, read: { String(Double($0)) },
      parse: {
        T(try number($0, range: range))
      })
  }

  public static func checked(_ binding: Binding<Bool>) -> Self {
    boolean("checked", binding: binding)
  }

  public static func enabled(_ binding: Binding<Bool>) -> Self {
    boolean("enabled", binding: binding)
  }

  private static func boolean(_ key: String, binding: Binding<Bool>) -> Self {
    bound(
      key, kind: .attribute, binding: binding, read: String.init,
      parse: {
        guard ["true", "false"].contains($0) else {
          throw InspectorError.invalid("Expected true or false")
        }
        return $0 == "true"
      })
  }

  /// Register a numeric property used by a matching SwiftUI modifier in your view.
  public static func numberStyle<T: BinaryFloatingPoint>(
    _ name: String, _ binding: Binding<T>, range: ClosedRange<Double> = 0...10000
  ) -> Self {
    let unitless = ["opacity", "z-index", "font-weight"].contains(name)
    return bound(
      name, kind: .style, binding: binding,
      read: {
        "\(Double($0))\(unitless ? "" : "px")"
      }, parse: { T(try number($0, range: range, points: !unitless)) })
  }

  public static func color(_ name: String, _ binding: Binding<Color>) -> Self {
    bound(
      name, kind: .style, binding: binding, read: cssColor,
      parse: {
        #if canImport(AppKit)
          Color(nsColor: try NativeStyles.parseColor($0))
        #else
          Color(uiColor: try NativeStyles.parseColor($0))
        #endif
      })
  }

  /// Optional .frame(width:/height:) bindings support genuine intrinsic sizing via `auto`.
  public static func dimension(_ name: String, _ binding: Binding<CGFloat?>) -> Self {
    bound(
      name, kind: .style, binding: binding,
      read: { $0.map { "\($0)px" } ?? "auto" },
      parse: {
        if $0 == "auto" { return nil }
        return CGFloat(try number($0, range: 0...10000, points: true))
      })
  }

  /// Use for string-valued modifiers, with an explicit supported value set.
  public static func stringStyle(
    _ name: String, _ binding: Binding<String>, allowed: [String]
  ) -> Self {
    bound(
      name, kind: .style, binding: binding, read: { $0 },
      parse: {
        guard allowed.contains($0) else {
          throw InspectorError.invalid("Choose one of: \(allowed.joined(separator: ", "))")
        }
        return $0
      })
  }

  public static func date(_ binding: Binding<Date>) -> Self {
    bound(
      "value", kind: .attribute, binding: binding,
      read: { ISO8601DateFormatter().string(from: $0) },
      parse: {
        guard let date = ISO8601DateFormatter().date(from: $0) else {
          throw InspectorError.invalid("Expected an ISO 8601 date")
        }
        return date
      })
  }

  private static func number(
    _ text: String, range: ClosedRange<Double>, points: Bool = false
  ) throws -> Double {
    let input = points && text.hasSuffix("px") ? String(text.dropLast(2)) : text
    guard let value = Double(input), value.isFinite, range.contains(value) else {
      throw InspectorError.invalid(
        "Expected a finite number in \(range)\(points ? " (native points)" : "")")
    }
    return value
  }

  private static func cssColor(_ color: Color) -> String {
    #if canImport(AppKit)
      guard let native = NSColor(color).usingColorSpace(.sRGB) else { return "transparent" }
      let r = native.redComponent
      let g = native.greenComponent
      let b = native.blueComponent
      let a = native.alphaComponent
    #else
      var r: CGFloat = 0
      var g: CGFloat = 0
      var b: CGFloat = 0
      var a: CGFloat = 0
      guard UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a) else { return "transparent" }
    #endif
    return
      "rgba(\(Int((r * 255).rounded())), \(Int((g * 255).rounded())), \(Int((b * 255).rounded())), \(a))"
  }
}

/// Register the same action closure as the Button. Source links point to its registration site.
public struct SwiftUIAction {
  let name: String
  let file: String
  let line: Int
  let perform: @MainActor () -> Void

  public init(
    _ name: String, file: String = #filePath, line: Int = #line,
    perform: @escaping @MainActor () -> Void
  ) {
    self.name = name
    self.file = file
    self.line = line
    self.perform = perform
  }
}

final class SwiftUIInspectionNode: NSObject {
  let identifier: String
  var tag: String
  var parent: String?
  var properties: [SwiftUIProperty]
  var action: SwiftUIAction?
  weak var probe: InspectorView?
  weak var registry: SwiftUIInspectionRegistry?
  var baselines: [String: () -> Void] = [:]

  init(
    id: String, tag: String, parent: String?, properties: [SwiftUIProperty], action: SwiftUIAction?
  ) {
    identifier = id
    self.tag = tag
    self.parent = parent
    self.properties = properties
    self.action = action
  }

  var attached: Bool { probe?.window != nil && registry?.contains(self) == true }

  func property(_ name: String, kind: SwiftUIProperty.Kind) throws -> SwiftUIProperty {
    let key = name == "background" ? "background-color" : name
    let matches = properties.filter { $0.key == key && $0.kind == kind }
    guard matches.count == 1 else {
      throw InspectorError.invalid(
        "SwiftUI property '\(key)' needs one registered binding on #\(identifier)")
    }
    return matches[0]
  }

  func checkpoint(_ operations: [[String: Any]]) throws -> () -> Void {
    let restore = try Set(operations.compactMap { $0["key"] as? String }).map {
      try property($0, kind: .style).capture()
    }
    let saved = baselines
    return {
      restore.forEach { $0() }
      self.baselines = saved
    }
  }

  func apply(_ operations: [[String: Any]]) throws {
    try registry?.validate(self)
    guard operations.count <= 256 else {
      throw InspectorError.invalid("SwiftUI edit limit exceeded")
    }
    let rollback = try checkpoint(operations)
    do {
      for operation in operations {
        let property = try property(operation["key"] as? String ?? "", kind: .style)
        let value = operation["value"] as? String ?? ""
        if value.isEmpty || operation["reset"] as? Bool == true {
          baselines.removeValue(forKey: property.key)?()
        } else {
          guard let write = property.write else {
            throw InspectorError.invalid("Read-only SwiftUI style")
          }
          if baselines[property.key] == nil { baselines[property.key] = property.capture() }
          try write(value)
        }
      }
    } catch {
      rollback()
      throw error
    }
  }

  func attribute(_ key: String) throws -> SwiftUIProperty {
    let names = ["text", "textContent", "title"]
    if names.contains(key) { return try property("text", kind: .text) }
    return try property(key, kind: .attribute)
  }

  func setAttribute(_ key: String, value: String) throws {
    try registry?.validate(self)
    let property = try attribute(key)
    guard let write = property.write else {
      throw InspectorError.invalid("Read-only SwiftUI text; register Binding<String> to edit it")
    }
    try write(value)
  }

  var styles: [String: String] {
    properties.filter { $0.kind == .style }.reduce(into: [:]) { $0[$1.key] = $1.read() }
  }

  var listeners: [[String: Any]] {
    guard let action else { return [] }
    return [
      [
        "type": "action", "kind": "SwiftUI closure", "target": tag,
        "selector": action.name, "dispatch": "registered public closure",
        "enabled": properties.first(where: { $0.key == "enabled" })?.read() != "false",
        "file": action.file, "line": action.line,
      ]
    ]
  }
}
