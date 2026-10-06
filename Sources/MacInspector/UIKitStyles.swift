// SPDX-License-Identifier: MIT
#if canImport(UIKit)
  import UIKit

  final class NativeStyles {
    static let properties = [
      "background", "background-color", "color", "opacity", "visibility", "color-scheme",
      "border", "border-width", "border-color", "border-style", "border-radius", "overflow",
      "z-index", "transform", "font-family", "font-size", "font-weight", "font-style",
      "text-align", "white-space", "text-overflow", "-webkit-line-clamp", "accent-color",
      "caret-color", "user-select", "object-fit", "gap", "flex-direction", "align-items",
      "justify-content", "padding", "padding-top", "padding-right", "padding-bottom",
      "padding-left", "width", "height",
    ]
    private weak var view: UIView?
    private let dimensions: NativeDimensions
    private var declarations: [(key: String, value: String)] = []
    private var baselines: [String: () -> Void] = [:]

    init(_ view: UIView) {
      self.view = view
      dimensions = NativeDimensions(view)
    }

    func snapshot() -> [String: String] {
      guard let view else { return [:] }
      var values = Self.snapshot(view).merging(dimensions.snapshot()) { _, size in size }
      for key in ["width", "height"] where declarations.contains(where: { $0.key == key }) {
        if values[key] == nil { values[key] = "auto" }
      }
      return values
    }

    private static func group(_ key: String) -> String {
      switch key {
      case "background", "background-color": return "background"
      case "border", "border-width", "border-color", "border-style": return "border"
      case "font-size", "font-family", "font-weight", "font-style": return "font"
      case "white-space", "text-overflow", "-webkit-line-clamp": return "wrapping"
      case "padding", "padding-top", "padding-right", "padding-bottom", "padding-left":
        return "padding"
      default: return key
      }
    }

    func checkpoint(_ operations: [[String: Any]]) throws -> () -> Void {
      guard let view else { throw InspectorError.invalid("Detached UIKit view") }
      let restores = Set(operations.compactMap { ($0["key"] as? String).map(Self.group) }).map {
        capture(view, group: $0)
      }
      let saved = declarations
      let baseline = baselines
      return {
        for operation in restores { operation() }
        self.declarations = saved
        self.baselines = baseline
        view.invalidateIntrinsicContentSize()
        view.setNeedsLayout()
        view.window?.layoutIfNeeded()
      }
    }

    func apply(_ operations: [[String: Any]]) throws {
      guard let view else { throw InspectorError.invalid("Detached UIKit view") }
      let rollback = try checkpoint(operations)
      var affected = Set<String>()
      do {
        for operation in operations {
          var key = operation["key"] as? String ?? ""
          guard Self.properties.contains(key) else {
            throw InspectorError.invalid("Unsupported UIKit style: \(key)")
          }
          if key == "background" { key = "background-color" }
          let group = Self.group(key)
          if operation["reset"] as? Bool == true {
            declarations.removeAll { $0.key == key }
          } else {
            let value = (operation["value"] as? String ?? "").trimmingCharacters(
              in: .whitespacesAndNewlines)
            guard !value.isEmpty, value.utf8.count <= 4096 else {
              throw InspectorError.invalid("Invalid UIKit style value")
            }
            if baselines[group] == nil { baselines[group] = capture(view, group: group) }
            declarations.removeAll { $0.key == key }
            declarations.append((key, value))
          }
          affected.insert(group)
        }
        for group in affected.sorted() {
          baselines[group]?()
          for declaration in declarations where Self.group(declaration.key) == group {
            try set(view, key: declaration.key, value: declaration.value)
          }
          if !declarations.contains(where: { Self.group($0.key) == group }) {
            baselines.removeValue(forKey: group)
          }
        }
        view.invalidateIntrinsicContentSize()
        view.setNeedsLayout()
        view.window?.layoutIfNeeded()
        try dimensions.validate()
      } catch {
        rollback()
        throw error
      }
    }

    private static func label(_ view: UIView) -> UILabel? {
      (view as? UILabel) ?? (view as? UIButton)?.titleLabel
    }
    private static func font(_ view: UIView) -> UIFont? {
      label(view)?.font ?? (view as? UITextField)?.font ?? (view as? UITextView)?.font
    }
    private static func setFont(_ view: UIView, _ font: UIFont) throws {
      if let label = label(view) {
        label.font = font
      } else if let field = view as? UITextField {
        field.font = font
      } else if let text = view as? UITextView {
        text.font = font
      } else {
        throw InspectorError.invalid("This UIKit view has no font")
      }
    }
    private static func color(_ view: UIView) -> UIColor? {
      if let button = view as? UIButton { return button.titleColor(for: .normal) }
      return (view as? UILabel)?.textColor ?? (view as? UITextField)?.textColor
        ?? (view as? UITextView)?.textColor
    }
    private static func setColor(_ view: UIView, _ color: UIColor?) throws {
      if let button = view as? UIButton {
        button.setTitleColor(color, for: .normal)
      } else if let label = view as? UILabel {
        label.textColor = color
      } else if let field = view as? UITextField {
        field.textColor = color
      } else if let text = view as? UITextView {
        text.textColor = color
      } else {
        throw InspectorError.invalid("This UIKit view has no text color")
      }
    }

    private func capture(_ view: UIView, group: String) -> () -> Void {
      switch group {
      case "width", "height": return dimensions.checkpoint(group)
      case "background":
        let value = view.backgroundColor
        return { view.backgroundColor = value }
      case "border":
        let width = view.layer.borderWidth
        let color = view.layer.borderColor
        return {
          view.layer.borderWidth = width
          view.layer.borderColor = color
        }
      case "border-radius":
        let value = view.layer.cornerRadius
        return { view.layer.cornerRadius = value }
      case "opacity":
        let value = view.alpha
        return { view.alpha = value }
      case "visibility":
        let value = view.isHidden
        return { view.isHidden = value }
      case "overflow":
        let value = view.clipsToBounds
        return { view.clipsToBounds = value }
      case "z-index":
        let value = view.layer.zPosition
        return { view.layer.zPosition = value }
      case "transform":
        let value = view.transform
        return { view.transform = value }
      case "color-scheme":
        let value = view.overrideUserInterfaceStyle
        return { view.overrideUserInterfaceStyle = value }
      case "font":
        let value = Self.font(view)
        return { if let value { try? Self.setFont(view, value) } }
      case "color":
        let value = Self.color(view)
        return { try? Self.setColor(view, value) }
      case "text-align":
        let label = Self.label(view)
        let field = view as? UITextField
        let text = view as? UITextView
        let alignment =
          label?.textAlignment ?? field?.textAlignment ?? text?.textAlignment ?? .natural
        return {
          label?.textAlignment = alignment
          field?.textAlignment = alignment
          text?.textAlignment = alignment
        }
      case "wrapping":
        let label = Self.label(view)
        let count = Self.label(view)?.numberOfLines ?? 1
        let mode = Self.label(view)?.lineBreakMode ?? .byWordWrapping
        return {
          label?.numberOfLines = count
          label?.lineBreakMode = mode
        }
      case "accent-color", "caret-color":
        let value = view.tintColor
        return { view.tintColor = value }
      case "user-select":
        let text = view as? UITextView
        let value = (view as? UITextView)?.isSelectable ?? false
        return { text?.isSelectable = value }
      case "object-fit":
        let value = view.contentMode
        return { view.contentMode = value }
      case "gap":
        let stack = view as? UIStackView
        let value = (view as? UIStackView)?.spacing ?? 0
        return { stack?.spacing = value }
      case "flex-direction":
        let stack = view as? UIStackView
        let value = (view as? UIStackView)?.axis ?? .horizontal
        return { stack?.axis = value }
      case "align-items":
        let stack = view as? UIStackView
        let value = (view as? UIStackView)?.alignment ?? .fill
        return { stack?.alignment = value }
      case "justify-content":
        let stack = view as? UIStackView
        let value = (view as? UIStackView)?.distribution ?? .fill
        return { stack?.distribution = value }
      case "padding":
        let stack = view as? UIStackView
        let margins = view.layoutMargins
        let relative = (view as? UIStackView)?.isLayoutMarginsRelativeArrangement ?? false
        return {
          view.layoutMargins = margins
          stack?.isLayoutMarginsRelativeArrangement = relative
        }
      default: return {}
      }
    }

    private func length(_ value: String, range: ClosedRange<Double> = 0...10000) throws -> CGFloat {
      let text = value.hasSuffix("px") ? String(value.dropLast(2)) : value
      guard let number = Double(text), number.isFinite, range.contains(number) else {
        throw InspectorError.invalid("Expected a finite UIKit point value")
      }
      return CGFloat(number)
    }

    static func parseColor(_ text: String) throws -> UIColor {
      let names = [
        "red": "#ff0000", "green": "#008000", "blue": "#0000ff", "white": "#ffffff",
        "black": "#000000", "yellow": "#ffff00", "orange": "#ffa500", "purple": "#800080",
        "gray": "#808080", "grey": "#808080", "indianred": "#cd5c5c", "rebeccapurple": "#663399",
      ]
      let value = names[text.lowercased()] ?? text.lowercased()
      if value == "transparent" { return .clear }
      if value.hasPrefix("#") {
        var hex = String(value.dropFirst())
        if hex.count == 3 || hex.count == 4 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard [6, 8].contains(hex.count), let number = UInt64(hex, radix: 16) else {
          throw InspectorError.invalid("Invalid hex color")
        }
        if hex.count == 6 {
          return UIColor(
            red: CGFloat((number >> 16) & 255) / 255, green: CGFloat((number >> 8) & 255) / 255,
            blue: CGFloat(number & 255) / 255, alpha: 1)
        }
        return UIColor(
          red: CGFloat((number >> 24) & 255) / 255, green: CGFloat((number >> 16) & 255) / 255,
          blue: CGFloat((number >> 8) & 255) / 255, alpha: CGFloat(number & 255) / 255)
      }
      if value.hasPrefix("rgb(") || value.hasPrefix("rgba("), value.hasSuffix(")"),
        let begin = value.firstIndex(of: "(")
      {
        let fields = value[value.index(after: begin)..<value.index(before: value.endIndex)].split(
          separator: ","
        ).map { $0.trimmingCharacters(in: .whitespaces) }
        let numbers = fields.compactMap(Double.init)
        guard numbers.count == fields.count, numbers.count == (value.hasPrefix("rgba") ? 4 : 3),
          numbers.allSatisfy({ $0.isFinite }),
          numbers.prefix(3).allSatisfy({ (0...255).contains($0) }),
          numbers.count == 3 || (0...1).contains(numbers[3])
        else { throw InspectorError.invalid("Invalid rgb color") }
        return UIColor(
          red: numbers[0] / 255, green: numbers[1] / 255, blue: numbers[2] / 255,
          alpha: numbers.count == 4 ? numbers[3] : 1)
      }
      throw InspectorError.invalid("Use a supported named, hex, rgb or rgba color")
    }

    private func set(_ view: UIView, key: String, value: String) throws {
      switch key {
      case "width", "height": try dimensions.set(key, value: value)
      case "background", "background-color": view.backgroundColor = try Self.parseColor(value)
      case "color": try Self.setColor(view, Self.parseColor(value))
      case "opacity": view.alpha = try length(value, range: 0...1)
      case "visibility":
        guard ["visible", "hidden"].contains(value) else {
          throw InspectorError.invalid("Use visible or hidden")
        }
        view.isHidden = value == "hidden"
      case "overflow":
        guard ["visible", "hidden", "clip"].contains(value) else {
          throw InspectorError.invalid("Use visible, hidden or clip")
        }
        view.clipsToBounds = value != "visible"
      case "border-width": view.layer.borderWidth = try length(value)
      case "border-color": view.layer.borderColor = try Self.parseColor(value).cgColor
      case "border-radius": view.layer.cornerRadius = try length(value)
      case "border-style":
        guard ["solid", "none", "hidden"].contains(value) else {
          throw InspectorError.invalid("Only solid native borders are supported")
        }
        if value != "solid" { view.layer.borderWidth = 0 }
      case "border":
        if value == "none" {
          view.layer.borderWidth = 0
          return
        }
        let fields = value.split(separator: " ", maxSplits: 2).map(String.init)
        guard fields.count == 3, fields[1] == "solid" else {
          throw InspectorError.invalid("Use <width> solid <color>")
        }
        let width = try length(fields[0])
        let color = try Self.parseColor(fields[2])
        view.layer.borderWidth = width
        view.layer.borderColor = color.cgColor
      case "z-index":
        guard let number = Int(value), abs(Double(number)) <= 1_000_000 else {
          throw InspectorError.invalid("Expected an integer z-index")
        }
        view.layer.zPosition = CGFloat(number)
      case "transform":
        if value == "none" {
          view.transform = .identity
          return
        }
        guard value.hasPrefix("matrix("), value.hasSuffix(")") else {
          throw InspectorError.invalid("Use none or a 2D matrix(a,b,c,d,tx,ty)")
        }
        let values = value.dropFirst(7).dropLast().split(separator: ",").compactMap {
          Double($0.trimmingCharacters(in: .whitespaces))
        }
        guard values.count == 6, values.allSatisfy({ $0.isFinite && abs($0) <= 1_000_000 }) else {
          throw InspectorError.invalid("Invalid 2D matrix")
        }
        view.transform = CGAffineTransform(
          a: values[0], b: values[1], c: values[2], d: values[3], tx: values[4], ty: values[5])
      case "color-scheme":
        guard
          let style = ["normal": UIUserInterfaceStyle.unspecified, "light": .light, "dark": .dark][
            value]
        else { throw InspectorError.invalid("Use normal, light or dark") }
        view.overrideUserInterfaceStyle = style
      case "font-size", "font-family", "font-weight", "font-style":
        guard let font = Self.font(view) else {
          throw InspectorError.invalid("This UIKit view has no font")
        }
        var descriptor = font.fontDescriptor
        var size = font.pointSize
        if key == "font-size" { size = try length(value, range: 1...300) }
        if key == "font-family" {
          let family = value.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
          if ["system-ui", "sans-serif"].contains(family) {
            descriptor = UIFont.systemFont(ofSize: size).fontDescriptor
          } else if family == "monospace" {
            descriptor = UIFont.monospacedSystemFont(ofSize: size, weight: .regular).fontDescriptor
          } else {
            guard UIFont.familyNames.contains(family) || UIFont(name: family, size: size) != nil
            else { throw InspectorError.invalid("Font is not installed on this device") }
            descriptor = UIFontDescriptor(fontAttributes: [.family: family])
          }
        }
        if key == "font-style" {
          guard ["normal", "italic", "oblique"].contains(value) else {
            throw InspectorError.invalid("Use normal or italic")
          }
          var traits = descriptor.symbolicTraits
          if value == "normal" { traits.remove(.traitItalic) } else { traits.insert(.traitItalic) }
          guard let changed = descriptor.withSymbolicTraits(traits) else {
            throw InspectorError.invalid("Font has no requested trait")
          }
          descriptor = changed
        }
        if key == "font-weight" {
          let weights: [String: UIFont.Weight] = [
            "normal": .regular, "bold": .bold, "100": .ultraLight, "200": .thin, "300": .light,
            "400": .regular, "500": .medium, "600": .semibold, "700": .bold, "800": .heavy,
            "900": .black,
          ]
          guard let weight = weights[value] else {
            throw InspectorError.invalid("Use normal, bold or a weight from 100 to 900")
          }
          descriptor = descriptor.addingAttributes([
            .traits: [UIFontDescriptor.TraitKey.weight: weight.rawValue]
          ])
        }
        try Self.setFont(view, UIFont(descriptor: descriptor, size: size))
      case "text-align":
        guard
          let alignment = [
            "left": NSTextAlignment.left, "center": .center, "right": .right, "justify": .justified,
            "start": .natural,
          ][value]
        else { throw InspectorError.invalid("Unsupported text alignment") }
        if let label = Self.label(view) {
          label.textAlignment = alignment
        } else if let field = view as? UITextField {
          field.textAlignment = alignment
        } else if let text = view as? UITextView {
          text.textAlignment = alignment
        } else {
          throw InspectorError.invalid("This UIKit view has no text alignment")
        }
      case "white-space", "text-overflow", "-webkit-line-clamp":
        guard let label = Self.label(view) else {
          throw InspectorError.invalid("Wrapping requires a native label")
        }
        if key == "white-space" {
          guard ["normal", "nowrap"].contains(value) else {
            throw InspectorError.invalid("Use normal or nowrap")
          }
          label.numberOfLines = value == "nowrap" ? 1 : 0
        } else if key == "text-overflow" {
          guard ["clip", "ellipsis"].contains(value) else {
            throw InspectorError.invalid("Use clip or ellipsis")
          }
          label.lineBreakMode = value == "ellipsis" ? .byTruncatingTail : .byClipping
        } else {
          guard let number = value == "none" ? 0 : Int(value), (0...10000).contains(number) else {
            throw InspectorError.invalid("Use none or a positive line count")
          }
          label.numberOfLines = number
        }
      case "accent-color", "caret-color":
        if key == "caret-color", !(view is UITextField || view is UITextView) {
          throw InspectorError.invalid("Caret color requires a text input")
        }
        view.tintColor = value == "auto" ? nil : try Self.parseColor(value)
      case "user-select":
        guard let text = view as? UITextView, ["none", "text", "auto"].contains(value) else {
          throw InspectorError.invalid("Selection requires UITextView and none/text/auto")
        }
        text.isSelectable = value != "none"
      case "object-fit":
        guard view is UIImageView,
          let mode = [
            "contain": UIView.ContentMode.scaleAspectFit, "cover": .scaleAspectFill,
            "fill": .scaleToFill, "none": .center,
          ][value]
        else { throw InspectorError.invalid("Image fitting requires contain/cover/fill/none") }
        view.contentMode = mode
      case "gap", "flex-direction", "align-items", "justify-content":
        guard let stack = view as? UIStackView else {
          throw InspectorError.invalid("This style requires UIStackView")
        }
        if key == "gap" { stack.spacing = try length(value) }
        if key == "flex-direction" {
          guard ["row", "column"].contains(value) else {
            throw InspectorError.invalid("Use row or column")
          }
          stack.axis = value == "row" ? .horizontal : .vertical
        }
        if key == "align-items" {
          guard
            let alignment = [
              "stretch": UIStackView.Alignment.fill, "flex-start": .leading, "flex-end": .trailing,
              "center": .center, "baseline": .firstBaseline,
            ][value]
          else { throw InspectorError.invalid("Unsupported stack alignment") }
          stack.alignment = alignment
        }
        if key == "justify-content" {
          guard
            let distribution = [
              "normal": UIStackView.Distribution.fill, "space-between": .equalSpacing,
              "space-around": .equalCentering,
            ][value]
          else { throw InspectorError.invalid("Unsupported stack distribution") }
          stack.distribution = distribution
        }
      case "padding", "padding-top", "padding-right", "padding-bottom", "padding-left":
        guard let stack = view as? UIStackView else {
          throw InspectorError.invalid("Padding requires UIStackView")
        }
        var margins = stack.layoutMargins
        if key == "padding" {
          let values = try value.split(separator: " ").map { try length(String($0)) }
          guard (1...4).contains(values.count) else {
            throw InspectorError.invalid("Padding takes one to four values")
          }
          margins = UIEdgeInsets(
            top: values[0],
            left: values.count == 4 ? values[3] : values.count >= 2 ? values[1] : values[0],
            bottom: values.count >= 3 ? values[2] : values[0],
            right: values.count >= 2 ? values[1] : values[0])
        } else {
          let number = try length(value)
          switch key {
          case "padding-top": margins.top = number
          case "padding-left": margins.left = number
          case "padding-bottom": margins.bottom = number
          default: margins.right = number
          }
        }
        stack.layoutMargins = margins
        stack.isLayoutMarginsRelativeArrangement = true
      default: throw InspectorError.invalid("Unsupported UIKit style")
      }
    }

    private static func css(_ color: UIColor?, view: UIView) -> String? {
      guard let color else { return nil }
      var r: CGFloat = 0
      var g: CGFloat = 0
      var b: CGFloat = 0
      var a: CGFloat = 0
      guard
        color.resolvedColor(with: view.traitCollection).getRed(&r, green: &g, blue: &b, alpha: &a)
      else { return nil }
      return
        "rgba(\(Int((r * 255).rounded())), \(Int((g * 255).rounded())), \(Int((b * 255).rounded())), \(a))"
    }

    static func snapshot(_ view: UIView) -> [String: String] {
      var result = [
        "opacity": "\(view.alpha)", "visibility": view.isHidden ? "hidden" : "visible",
        "border-radius": "\(view.layer.cornerRadius)px",
        "border-width": "\(view.layer.borderWidth)px",
        "border-style": view.layer.borderWidth == 0 ? "none" : "solid",
        "overflow": view.clipsToBounds ? "hidden" : "visible",
        "z-index": "\(Int(view.layer.zPosition))",
      ]
      result["background-color"] = css(view.backgroundColor, view: view)
      result["color"] = css(color(view), view: view)
      result["accent-color"] = css(view.tintColor, view: view)
      result["color-scheme"] =
        view.overrideUserInterfaceStyle == .dark
        ? "dark" : view.overrideUserInterfaceStyle == .light ? "light" : "normal"
      if view is UITextField || view is UITextView {
        result["caret-color"] = css(view.tintColor, view: view)
      }
      if let text = view as? UITextView {
        result["user-select"] = text.isSelectable ? "text" : "none"
      }
      if view is UIImageView {
        result["object-fit"] =
          [
            .scaleAspectFit: "contain", .scaleAspectFill: "cover", .scaleToFill: "fill",
            .center: "none",
          ][view.contentMode]
      }
      if let border = view.layer.borderColor {
        result["border-color"] = css(UIColor(cgColor: border), view: view)
      }
      if let font = font(view) {
        result["font-family"] = "\"\(font.familyName)\""
        result["font-size"] = "\(font.pointSize)px"
        result["font-style"] =
          font.fontDescriptor.symbolicTraits.contains(.traitItalic) ? "italic" : "normal"
        let traits =
          font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any]
        let weight =
          (traits?[.weight] as? NSNumber)?.doubleValue
          ?? (font.fontDescriptor.symbolicTraits.contains(.traitBold)
            ? Double(UIFont.Weight.bold.rawValue) : 0)
        let weights: [(Int, UIFont.Weight)] = [
          (100, .ultraLight), (200, .thin), (300, .light), (400, .regular), (500, .medium),
          (600, .semibold), (700, .bold), (800, .heavy), (900, .black),
        ]
        result["font-weight"] = weights.min {
          abs(Double($0.1.rawValue) - weight) < abs(Double($1.1.rawValue) - weight)
        }.map { String($0.0) }
      }
      let alignment =
        label(view)?.textAlignment ?? (view as? UITextField)?.textAlignment
        ?? (view as? UITextView)?.textAlignment
      if let alignment {
        result["text-align"] =
          [
            .left: "left", .center: "center", .right: "right", .justified: "justify",
            .natural: "start",
          ][alignment]
      }
      if let label = label(view) {
        result["text-align"] =
          [
            .left: "left", .center: "center", .right: "right", .justified: "justify",
            .natural: "start",
          ][label.textAlignment]
        result["-webkit-line-clamp"] = label.numberOfLines == 0 ? "none" : "\(label.numberOfLines)"
        result["white-space"] = label.numberOfLines == 1 ? "nowrap" : "normal"
        result["text-overflow"] = label.lineBreakMode == .byTruncatingTail ? "ellipsis" : "clip"
      }
      if let stack = view as? UIStackView {
        result["gap"] = "\(stack.spacing)px"
        result["flex-direction"] = stack.axis == .horizontal ? "row" : "column"
        result["align-items"] =
          [
            .fill: "stretch", .leading: "flex-start", .trailing: "flex-end", .center: "center",
            .firstBaseline: "baseline", .lastBaseline: "baseline",
          ][stack.alignment]
        result["justify-content"] =
          [.fill: "normal", .equalSpacing: "space-between", .equalCentering: "space-around"][
            stack.distribution]
        if stack.isLayoutMarginsRelativeArrangement {
          let m = stack.layoutMargins
          result["padding"] = "\(m.top)px \(m.right)px \(m.bottom)px \(m.left)px"
        }
      }
      let t = view.transform
      result["transform"] =
        t.isIdentity ? "none" : "matrix(\(t.a), \(t.b), \(t.c), \(t.d), \(t.tx), \(t.ty))"
      return result
    }
  }
#endif
