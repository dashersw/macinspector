// SPDX-License-Identifier: MIT
#if canImport(AppKit)
import AppKit
import QuartzCore

/// CSS declarations mapped onto native properties, with reversible resource groups.
/// A group is restored before replay so font traits and shorthands compose safely.
final class NativeStyles {
  static let properties = [
    "background", "background-color", "color", "opacity", "visibility", "color-scheme",
    "border", "border-style", "border-radius", "border-width", "border-color", "box-shadow",
    "overflow", "transform", "z-index", "font-size", "font-family", "font-weight", "font-style",
    "text-align", "text-decoration", "text-decoration-line", "text-decoration-color",
    "text-decoration-style", "letter-spacing", "line-height", "text-indent", "direction", "hyphens",
    "white-space", "text-overflow", "overflow-wrap", "-webkit-line-clamp", "user-select",
    "caret-color", "accent-color", "object-fit", "object-position", "gap", "flex-direction",
    "align-items", "justify-content", "padding", "padding-top", "padding-right", "padding-bottom",
    "padding-left", "width", "height",
  ]

  private weak var view: NSView?
  private let dimensions: NativeDimensions
  private var declarations: [(key: String, value: String)] = []
  private var baselines: [String: () -> Void] = [:]
  private var layerBaseline: Bool?
  private static let layerGroups: Set<String> = [
    "background", "border", "radius", "shadow", "overflow", "transform", "z-index",
  ]

  init(_ view: NSView) {
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

  private func relayout(_ view: NSView) {
    view.needsDisplay = true
    view.invalidateIntrinsicContentSize()
    view.superview?.needsLayout = true
    view.window?.contentView?.layoutSubtreeIfNeeded()
  }

  private static func group(_ key: String) -> String {
    switch key {
    case "background", "background-color": return "background"
    case "border", "border-style", "border-width", "border-color": return "border"
    case "border-radius": return "radius"
    case "box-shadow": return "shadow"
    case "padding", "padding-top", "padding-right", "padding-bottom", "padding-left":
      return "padding"
    case "font-family", "font-size", "font-weight", "font-style": return "font"
    case "text-decoration", "text-decoration-line", "text-decoration-color",
      "text-decoration-style":
      return "decoration"
    case "text-align", "line-height", "text-indent", "direction", "hyphens", "white-space",
      "text-overflow", "overflow-wrap", "-webkit-line-clamp":
      return "paragraph"
    default: return key
    }
  }

  private func ordered(_ groups: Set<String>) -> [String] {
    let order = ["flex-direction", "align-items", "font", "paragraph"]
    return groups.sorted {
      let a = order.firstIndex(of: $0) ?? order.count
      let b = order.firstIndex(of: $1) ?? order.count
      return a == b ? $0 < $1 : a < b
    }
  }

  func checkpoint(_ operations: [[String: Any]]) throws -> () -> Void {
    guard let view else { throw InspectorError.invalid("Detached native view") }
    let groups = Set(operations.compactMap { ($0["key"] as? String).map(Self.group) })
    let restore = ordered(groups).map { capture(view, group: $0) }
    let saved = declarations
    let savedBaselines = baselines
    let savedLayerBaseline = layerBaseline
    let wantsLayer = view.wantsLayer
    return {
      for operation in restore { operation() }
      view.wantsLayer = wantsLayer
      self.declarations = saved
      self.baselines = savedBaselines
      self.layerBaseline = savedLayerBaseline
      self.relayout(view)
    }
  }

  func apply(_ operations: [[String: Any]]) throws {
    guard let view else { throw InspectorError.invalid("Detached native view") }
    let saved = declarations
    let savedBaselines = baselines
    let savedLayerBaseline = layerBaseline
    let wantedLayer = view.wantsLayer
    var affected = Set<String>()
    do {
      for operation in operations {
        var key = operation["key"] as? String ?? ""
        guard Self.properties.contains(key) else {
          throw InspectorError.invalid("Unsupported native style: \(key)")
        }
        if key == "background" { key = "background-color" }
        let group = Self.group(key)
        if operation["reset"] as? Bool == true {
          guard declarations.contains(where: { $0.key == key }) else { continue }
          declarations.removeAll { $0.key == key }
        } else {
          let value = (operation["value"] as? String ?? "").trimmingCharacters(
            in: .whitespacesAndNewlines)
          guard !value.isEmpty, value.utf8.count <= 4096 else {
            throw InspectorError.invalid("Invalid native style value")
          }
          if Self.layerGroups.contains(group) && layerBaseline == nil {
            layerBaseline = view.wantsLayer
          }
          if baselines[group] == nil { baselines[group] = capture(view, group: group) }
          declarations.removeAll { $0.key == key }
          declarations.append((key, value))
        }
        affected.insert(group)
      }
      if affected.contains("font") && declarations.contains(where: { $0.key == "line-height" }) {
        affected.insert("paragraph")
      }
      for group in ordered(affected) {
        baselines[group]?()
        for declaration in replay(group) {
          try set(view, key: declaration.key, value: declaration.value)
        }
      }
      for group in affected where !declarations.contains(where: { Self.group($0.key) == group }) {
        baselines.removeValue(forKey: group)
      }
      if let layerBaseline,
        !declarations.contains(where: { Self.layerGroups.contains(Self.group($0.key)) })
      {
        view.wantsLayer = layerBaseline
        self.layerBaseline = nil
      }
      relayout(view)
      try dimensions.validate()
    } catch {
      for group in ordered(affected) { baselines[group]?() }
      declarations = saved
      baselines = savedBaselines
      layerBaseline = savedLayerBaseline
      for group in ordered(affected) {
        for declaration in replay(group) {
          try? set(view, key: declaration.key, value: declaration.value)
        }
      }
      view.wantsLayer = wantedLayer
      relayout(view)
      throw error
    }
  }

  private func replay(_ group: String) -> [(key: String, value: String)] {
    let values = declarations.filter { Self.group($0.key) == group }
    guard group == "font" else { return values }
    // Relative line heights use the final font, regardless of declaration order.
    let fonts = ["font-family", "font-size", "font-weight", "font-style"]
    return fonts.compactMap { key in values.last { $0.key == key } }
      + values.filter { !fonts.contains($0.key) }
  }

  private func capture(_ view: NSView, group: String) -> () -> Void {
    switch group {
    case "width", "height": return dimensions.checkpoint(group)
    case "background", "border", "radius", "shadow", "overflow", "transform", "z-index":
      let layer = view.layer
      let background = layer?.backgroundColor
      let border = layer?.borderColor
      let radius = layer?.cornerRadius ?? 0
      let width = layer?.borderWidth ?? 0
      let shadowColor = layer?.shadowColor
      let shadowOpacity = layer?.shadowOpacity ?? 0
      let shadowRadius = layer?.shadowRadius ?? 3
      let shadowOffset = layer?.shadowOffset ?? .zero
      let transform = layer?.transform ?? CATransform3DIdentity
      let z = layer?.zPosition ?? 0
      let masks = layer?.masksToBounds ?? false
      let field = view as? NSTextField
      let text = view as? NSTextView
      let fieldBackground = field?.backgroundColor
      let fieldDraws = field?.drawsBackground ?? false
      let textBackground = text?.backgroundColor
      let textDraws = text?.drawsBackground ?? false
      return { [weak view, weak field, weak text] in
        guard let view else { return }
        if let current = view.layer {
          if group == "background" { current.backgroundColor = background }
          if group == "border" {
            current.borderColor = border
            current.borderWidth = width
          }
          if group == "radius" { current.cornerRadius = radius }
          if group == "shadow" {
            current.shadowColor = shadowColor
            current.shadowOpacity = shadowOpacity
            current.shadowRadius = shadowRadius
            current.shadowOffset = shadowOffset
          }
          if group == "transform" { current.transform = transform }
          if group == "z-index" { current.zPosition = z }
          if group == "overflow" { current.masksToBounds = masks }
        }
        if group == "background" {
          if let fieldBackground { field?.backgroundColor = fieldBackground }
          field?.drawsBackground = fieldDraws
          if let textBackground { text?.backgroundColor = textBackground }
          text?.drawsBackground = textDraws
        }
      }
    case "gap", "flex-direction", "align-items", "justify-content", "padding":
      guard let stack = view as? NSStackView else { return {} }
      let orientation = stack.orientation
      let alignment = stack.alignment
      let distribution = stack.distribution
      let spacing = stack.spacing
      let insets = stack.edgeInsets
      let semantic = Self.stackAlignment(stack)
      return { [weak stack] in
        guard let stack else { return }
        if group == "gap" { stack.spacing = spacing }
        if group == "padding" { stack.edgeInsets = insets }
        if group == "justify-content" { stack.distribution = distribution }
        if group == "flex-direction" { Self.orient(stack, orientation) }
        if group == "align-items" {
          if stack.orientation == orientation {
            stack.alignment = alignment
          } else if let semantic {
            try? Self.align(stack, semantic)
          }
        }
      }
    case "object-fit", "object-position":
      guard let image = view as? NSImageView else { return {} }
      let scaling = image.imageScaling
      let alignment = image.imageAlignment
      return { [weak image] in
        if group == "object-fit" {
          image?.imageScaling = scaling
        } else {
          image?.imageAlignment = alignment
        }
      }
    case "opacity":
      let value = view.alphaValue
      return { [weak view] in view?.alphaValue = value }
    case "visibility":
      let value = view.isHidden
      return { [weak view] in view?.isHidden = value }
    case "color-scheme":
      let value = view.appearance
      return { [weak view] in view?.appearance = value }
    case "user-select":
      if let field = view as? NSTextField {
        let selectable = field.isSelectable
        let editable = field.isEditable
        return { [weak field] in
          field?.isEditable = editable
          field?.isSelectable = selectable
        }
      }
      if let text = view as? NSTextView {
        let selectable = text.isSelectable
        let editable = text.isEditable
        return { [weak text] in
          text?.isEditable = editable
          text?.isSelectable = selectable
        }
      }
      return {}
    case "caret-color":
      guard let text = view as? NSTextView else { return {} }
      let value = text.insertionPointColor
      return { [weak text] in text?.insertionPointColor = value }
    case "accent-color":
      if let button = view as? NSButton {
        let value = button.contentTintColor
        return { [weak button] in button?.contentTintColor = value }
      }
      if let image = view as? NSImageView {
        let value = image.contentTintColor
        return { [weak image] in image?.contentTintColor = value }
      }
      return {}
    default:
      let control = view as? NSControl
      let field = view as? NSTextField
      let text = view as? NSTextView
      let font = control?.font
      let alignment = control?.alignment
      let textFont = text?.font
      let textColor = text?.textColor
      let textAlignment = text?.alignment
      let paragraph = text?.defaultParagraphStyle
      let typing = text?.typingAttributes
      let fieldColor = field?.textColor
      let lineBreak = field?.lineBreakMode
      let lines = field?.maximumNumberOfLines
      let wraps = field?.cell?.wraps
      let scrollable = field?.cell?.isScrollable
      let single = field?.cell?.usesSingleLineMode
      let original = Self.attributed(view).map { NSAttributedString(attributedString: $0) }
      return { [weak view, weak control, weak field, weak text] in
        if group == "font" {
          control?.font = font
          text?.font = textFont
        }
        if group == "color" {
          field?.textColor = fieldColor
          text?.textColor = textColor
        }
        if group == "paragraph" {
          if let alignment { control?.alignment = alignment }
          if let lineBreak { field?.lineBreakMode = lineBreak }
          if let lines { field?.maximumNumberOfLines = lines }
          if let wraps { field?.cell?.wraps = wraps }
          if let scrollable { field?.cell?.isScrollable = scrollable }
          if let single { field?.cell?.usesSingleLineMode = single }
          if let textAlignment { text?.alignment = textAlignment }
          text?.defaultParagraphStyle = paragraph
        }
        let keys: [NSAttributedString.Key]
        switch group {
        case "font": keys = [.font]
        case "color": keys = [.foregroundColor]
        case "paragraph": keys = [.paragraphStyle]
        case "letter-spacing": keys = [.kern]
        default:
          keys = [.underlineStyle, .underlineColor, .strikethroughStyle, .strikethroughColor]
        }
        if let text, let typing {
          var current = text.typingAttributes
          for key in keys { current[key] = typing[key] }
          text.typingAttributes = current
        }
        if let view, let original, let current = Self.attributed(view) {
          let restored = NSMutableAttributedString(attributedString: current)
          for key in keys {
            restored.removeAttribute(key, range: NSRange(location: 0, length: restored.length))
            if original.string == current.string {
              original.enumerateAttribute(key, in: NSRange(location: 0, length: original.length)) {
                value, range, _ in
                if let value { restored.addAttribute(key, value: value, range: range) }
              }
            } else if original.length > 0,
              let value = original.attribute(key, at: 0, effectiveRange: nil)
            {
              restored.addAttribute(
                key, value: value, range: NSRange(location: 0, length: restored.length))
            }
          }
          Self.setAttributed(view, restored)
        }
      }
    }
  }

  private static func attributed(_ view: NSView) -> NSAttributedString? {
    if let field = view as? NSTextField { return field.attributedStringValue }
    if let button = view as? NSButton { return button.attributedTitle }
    if let text = view as? NSTextView { return text.textStorage }
    return nil
  }

  private static func setAttributed(_ view: NSView, _ string: NSAttributedString) {
    if let field = view as? NSTextField {
      field.attributedStringValue = string
    } else if let button = view as? NSButton {
      button.attributedTitle = string
    } else if let text = view as? NSTextView {
      text.textStorage?.setAttributedString(string)
    }
  }

  private static func font(_ view: NSView) -> NSFont? {
    if let string = attributed(view), string.length > 0,
      let font = string.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
    {
      return font
    }
    return (view as? NSControl)?.font ?? (view as? NSTextView)?.font
  }

  private static func attribute(_ view: NSView, _ key: NSAttributedString.Key) -> Any? {
    guard let string = attributed(view), string.length > 0 else { return nil }
    return string.attribute(key, at: 0, effectiveRange: nil)
  }

  private func setAttribute(_ view: NSView, _ key: NSAttributedString.Key, _ value: Any?) throws {
    guard let original = Self.attributed(view) else {
      throw InspectorError.invalid(
        "This property requires a native text field, text view or button")
    }
    let string = NSMutableAttributedString(attributedString: original)
    let range = NSRange(location: 0, length: string.length)
    if let value {
      string.addAttribute(key, value: value, range: range)
    } else {
      string.removeAttribute(key, range: range)
    }
    Self.setAttributed(view, string)
    if let text = view as? NSTextView {
      var typing = text.typingAttributes
      typing[key] = value
      text.typingAttributes = typing
    }
  }

  private func setFont(_ view: NSView, _ font: NSFont) throws {
    guard view is NSControl || view is NSTextView else {
      throw InspectorError.invalid("This view has no native font")
    }
    (view as? NSControl)?.font = font
    (view as? NSTextView)?.font = font
    if Self.attributed(view) != nil { try setAttribute(view, .font, font) }
  }

  private func setParagraph(_ view: NSView, change: (NSMutableParagraphStyle) throws -> Void) throws
  {
    let paragraph =
      (Self.attribute(view, .paragraphStyle) as? NSParagraphStyle
      ?? (view as? NSTextView)?.defaultParagraphStyle ?? .default).mutableCopy()
      as! NSMutableParagraphStyle
    try change(paragraph)
    try setAttribute(view, .paragraphStyle, paragraph)
    (view as? NSTextView)?.defaultParagraphStyle = paragraph
  }

  private func set(_ view: NSView, key: String, value: String) throws {
    switch key {
    case "width", "height": try dimensions.set(key, value: value)
    case "opacity": view.alphaValue = try Self.number(value, min: 0, max: 1, length: false)
    case "visibility":
      guard ["visible", "hidden"].contains(value) else {
        throw InspectorError.invalid("Use visible or hidden")
      }
      view.isHidden = value == "hidden"
    case "color-scheme":
      guard ["normal", "light", "dark"].contains(value) else {
        throw InspectorError.invalid("Use normal, light or dark")
      }
      view.appearance =
        value == "normal" ? nil : NSAppearance(named: value == "dark" ? .darkAqua : .aqua)
    case "background-color":
      let color = try Self.parseColor(value)
      view.wantsLayer = true
      view.layer?.backgroundColor = color.cgColor
      if let field = view as? NSTextField {
        field.backgroundColor = color
        field.drawsBackground = color.alphaComponent > 0
      }
      if let text = view as? NSTextView {
        text.backgroundColor = color
        text.drawsBackground = color.alphaComponent > 0
      }
    case "border-width", "border-radius", "z-index":
      let number = try Self.number(
        value, min: key == "z-index" ? -10000 : 0, length: key != "z-index")
      if key == "z-index", number.rounded() != number {
        throw InspectorError.invalid("z-index requires an integer")
      }
      view.wantsLayer = true
      if key == "border-width" {
        view.layer?.borderWidth = number
      } else if key == "border-radius" {
        view.layer?.cornerRadius = number
      } else {
        view.layer?.zPosition = number
      }
    case "border-color":
      let color = try Self.parseColor(value)
      view.wantsLayer = true
      view.layer?.borderColor = color.cgColor
    case "border-style":
      guard ["solid", "none", "hidden"].contains(value) else {
        throw InspectorError.invalid("Native layer borders support solid, none or hidden")
      }
      view.wantsLayer = true
      if value != "solid" { view.layer?.borderWidth = 0 }
    case "border":
      if value == "none" {
        try set(view, key: "border-style", value: "none")
        return
      }
      let parts = Self.tokens(value)
      guard parts.count == 3, parts[1] == "solid" else {
        throw InspectorError.invalid("Use <width> solid <color> or none")
      }
      try set(view, key: "border-width", value: parts[0])
      try set(view, key: "border-color", value: parts[2])
    case "overflow":
      guard ["visible", "hidden", "clip"].contains(value) else {
        throw InspectorError.invalid("Native clipping supports visible, hidden or clip")
      }
      view.wantsLayer = true
      view.layer?.masksToBounds = value != "visible"
    case "box-shadow":
      view.wantsLayer = true
      if value == "none" {
        view.layer?.shadowOpacity = 0
        return
      }
      var parts = Self.tokens(value)
      var color = NSColor.black
      if let last = parts.last, let parsed = try? Self.parseColor(last) {
        color = parsed
        parts.removeLast()
      } else if let first = parts.first, let parsed = try? Self.parseColor(first) {
        color = parsed
        parts.removeFirst()
      }
      guard (2...3).contains(parts.count) else {
        throw InspectorError.invalid(
          "Use one shadow: <x> <y> [blur] [color]; inset and spread are unsupported")
      }
      let x = try Self.number(parts[0])
      let y = try Self.number(parts[1])
      let blur = parts.count == 3 ? try Self.number(parts[2], min: 0) : 0
      view.layer?.shadowOffset = CGSize(width: x, height: view.isFlipped ? y : -y)
      view.layer?.shadowRadius = blur / 2
      view.layer?.shadowColor = color.withAlphaComponent(1).cgColor
      view.layer?.shadowOpacity = Float(color.alphaComponent)
    case "transform":
      let transform = try Self.transform(value)
      view.wantsLayer = true
      view.layer?.setAffineTransform(transform)
    case "color":
      let color = try Self.parseColor(value)
      guard view is NSTextField || view is NSTextView || view is NSButton else {
        throw InspectorError.invalid("This native view does not expose text color")
      }
      if let field = view as? NSTextField {
        field.textColor = color
      } else if let text = view as? NSTextView {
        text.textColor = color
      }
      try setAttribute(view, .foregroundColor, color)
    case "font-size":
      let size = try Self.number(value, min: 1, max: 300)
      let original = Self.font(view) ?? .systemFont(ofSize: size)
      guard let font = NSFont(descriptor: original.fontDescriptor, size: size) else {
        throw InspectorError.invalid("Cannot resize this font")
      }
      try setFont(view, font)
    case "font-family":
      let size = Self.font(view)?.pointSize ?? 13
      let name = value.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
      let font: NSFont?
      switch name {
      case "system-ui", "sans-serif": font = .systemFont(ofSize: size)
      case "monospace": font = .monospacedSystemFont(ofSize: size, weight: .regular)
      case "serif": font = NSFont(name: "Times", size: size)
      default: font = NSFont(name: name, size: size)
      }
      guard let font else { throw InspectorError.invalid("Unknown native font family") }
      let original = Self.font(view)
      var result = font
      if let original {
        let traits = NSFontManager.shared.traits(of: original).intersection([
          .boldFontMask, .italicFontMask,
        ])
        result = NSFontManager.shared.convert(font, toHaveTrait: traits)
      }
      try setFont(view, result)
    case "font-weight":
      guard let font = Self.font(view) else {
        throw InspectorError.invalid("Use normal, bold or a weight from 100 to 900 on native text")
      }
      let cssWeight =
        value == "normal"
        ? 400 : value == "bold" ? 700 : try Self.number(value, min: 100, max: 900, length: false)
      let weights: [NSFont.Weight] = [
        .ultraLight, .thin, .light, .regular, .medium, .semibold, .bold, .heavy, .black,
      ]
      let lower = min(7, Int(cssWeight / 100) - 1)
      let fraction = (cssWeight - CGFloat((lower + 1) * 100)) / 100
      let weight =
        weights[lower].rawValue + (weights[lower + 1].rawValue - weights[lower].rawValue) * fraction
      let base = NSFontManager.shared.convert(font, toHaveTrait: .unboldFontMask)
      var traits =
        base.fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any] ?? [:]
      traits[.weight] = weight
      // A PostScript name pins a face and prevents weight matching. Ask the
      // native font matcher for the family and traits instead.
      var attributes = base.fontDescriptor.fontAttributes
      attributes.removeValue(forKey: .name)
      attributes.removeValue(forKey: .face)
      attributes[.family] = font.familyName
      attributes[.traits] = traits
      let descriptor = NSFontDescriptor(fontAttributes: attributes)
      guard let result = NSFont(descriptor: descriptor, size: font.pointSize) else {
        throw InspectorError.invalid("Font does not support this weight")
      }
      try setFont(view, result)
    case "font-style":
      guard ["normal", "italic", "oblique"].contains(value), let font = Self.font(view) else {
        throw InspectorError.invalid("Use normal, italic or oblique on native text")
      }
      try setFont(
        view,
        NSFontManager.shared.convert(
          font, toHaveTrait: value == "normal" ? .unitalicFontMask : .italicFontMask))
    case "text-align":
      let alignments: [String: NSTextAlignment] = [
        "left": .left, "center": .center, "right": .right, "justify": .justified, "start": .natural,
      ]
      guard let alignment = alignments[value], view is NSControl || view is NSTextView else {
        throw InspectorError.invalid("Invalid native text alignment")
      }
      (view as? NSControl)?.alignment = alignment
      (view as? NSTextView)?.alignment = alignment
      try setParagraph(view) { $0.alignment = alignment }
    case "letter-spacing":
      try setAttribute(view, .kern, value == "normal" ? nil : try Self.number(value))
    case "line-height":
      let height: CGFloat
      if value == "normal" {
        height = 0
      } else if value.hasSuffix("px") {
        height = try Self.number(value, min: 1)
      } else {
        height =
          try Self.number(value, min: 0.1, max: 100, length: false)
          * (Self.font(view)?.pointSize ?? 13)
      }
      try setParagraph(view) {
        $0.minimumLineHeight = height
        $0.maximumLineHeight = height
      }
    case "text-indent":
      let indent = try Self.number(value)
      try setParagraph(view) { $0.firstLineHeadIndent = indent }
    case "direction":
      guard ["ltr", "rtl"].contains(value) else { throw InspectorError.invalid("Use ltr or rtl") }
      try setParagraph(view) {
        $0.baseWritingDirection = value == "rtl" ? .rightToLeft : .leftToRight
      }
    case "hyphens":
      guard ["none", "manual", "auto"].contains(value) else {
        throw InspectorError.invalid("Use none, manual or auto")
      }
      try setParagraph(view) { $0.hyphenationFactor = value == "auto" ? 1 : 0 }
    case "text-decoration", "text-decoration-line":
      var parts = Self.tokens(value)
      var requestedStyle: Int? = key == "text-decoration" ? NSUnderlineStyle.single.rawValue : nil
      if key == "text-decoration" {
        if let last = parts.last, let color = try? Self.parseColor(last) {
          try set(view, key: "text-decoration-color", value: Self.color(color))
          parts.removeLast()
        }
        if let style = parts.first(where: { ["solid", "double", "dotted", "dashed"].contains($0) })
        {
          requestedStyle = try Self.decorationStyle(style)
          parts.removeAll { $0 == style }
        }
      }
      guard !parts.isEmpty,
        parts.allSatisfy({ ["none", "underline", "line-through"].contains($0) }),
        !(parts.contains("none") && parts.count > 1)
      else { throw InspectorError.invalid("Use none, underline and/or line-through") }
      let old = (Self.attribute(view, .underlineStyle) as? Int ?? 1)
      let declared = declarations.last(where: { $0.key == "text-decoration-style" })?.value
      let style =
        try requestedStyle ?? declared.map(Self.decorationStyle)
        ?? (old == 0 ? NSUnderlineStyle.single.rawValue : old)
      try setAttribute(view, .underlineStyle, parts.contains("underline") ? style : 0)
      try setAttribute(view, .strikethroughStyle, parts.contains("line-through") ? style : 0)
    case "text-decoration-color":
      let color = try Self.parseColor(value)
      try setAttribute(view, .underlineColor, color)
      try setAttribute(view, .strikethroughColor, color)
    case "text-decoration-style":
      let style = try Self.decorationStyle(value)
      for key in [NSAttributedString.Key.underlineStyle, .strikethroughStyle] {
        if (Self.attribute(view, key) as? Int ?? 0) != 0 { try setAttribute(view, key, style) }
      }
    case "white-space", "text-overflow", "overflow-wrap", "-webkit-line-clamp":
      guard let field = view as? NSTextField else {
        throw InspectorError.invalid("This property requires NSTextField")
      }
      if key == "white-space" {
        guard ["normal", "nowrap"].contains(value) else {
          throw InspectorError.invalid("Use normal or nowrap")
        }
        field.cell?.wraps = value == "normal"
        field.cell?.usesSingleLineMode = value == "nowrap"
        field.cell?.isScrollable = value == "nowrap"
      } else if key == "text-overflow" {
        guard ["clip", "ellipsis"].contains(value) else {
          throw InspectorError.invalid("Use clip or ellipsis")
        }
        field.lineBreakMode = value == "ellipsis" ? .byTruncatingTail : .byClipping
        try setParagraph(view) { $0.lineBreakMode = field.lineBreakMode }
      } else if key == "overflow-wrap" {
        guard ["normal", "anywhere", "break-word"].contains(value) else {
          throw InspectorError.invalid("Use normal, anywhere or break-word")
        }
        field.lineBreakMode = value == "normal" ? .byWordWrapping : .byCharWrapping
        try setParagraph(view) { $0.lineBreakMode = field.lineBreakMode }
      } else {
        let count = value == "none" ? 0 : try Self.number(value, min: 1, max: 10000)
        guard count.rounded() == count else {
          throw InspectorError.invalid("Line clamp requires a positive integer or none")
        }
        field.maximumNumberOfLines = Int(count)
      }
    case "user-select":
      guard ["none", "text", "auto"].contains(value) else {
        throw InspectorError.invalid("Use none, text or auto")
      }
      if let field = view as? NSTextField {
        field.isSelectable = value != "none"
      } else if let text = view as? NSTextView {
        text.isSelectable = value != "none"
      } else {
        throw InspectorError.invalid("Selection requires a text field or text view")
      }
    case "caret-color":
      guard let text = view as? NSTextView else {
        throw InspectorError.invalid("Caret color requires NSTextView")
      }
      text.insertionPointColor = try Self.parseColor(value)
    case "accent-color":
      let color = value == "auto" ? nil : try Self.parseColor(value)
      if let button = view as? NSButton {
        button.contentTintColor = color
      } else if let image = view as? NSImageView {
        image.contentTintColor = color
      } else {
        throw InspectorError.invalid("Native tint is supported on buttons and image views")
      }
    case "object-fit":
      let scaling: [String: NSImageScaling] = [
        "contain": .scaleProportionallyUpOrDown, "fill": .scaleAxesIndependently,
        "none": .scaleNone, "scale-down": .scaleProportionallyDown,
      ]
      guard let image = view as? NSImageView, let scale = scaling[value] else {
        throw InspectorError.invalid(
          "Native image fitting supports contain, fill, none or scale-down")
      }
      image.imageScaling = scale
    case "object-position":
      guard let image = view as? NSImageView, let alignment = Self.imagePositions[value] else {
        throw InspectorError.invalid(
          "Use center, top, bottom, left, right or two edge keywords on an image view")
      }
      image.imageAlignment = alignment
    case "gap", "flex-direction", "align-items", "justify-content", "padding", "padding-top",
      "padding-right", "padding-bottom", "padding-left":
      guard let stack = view as? NSStackView else {
        throw InspectorError.invalid("This property requires NSStackView")
      }
      if key == "gap" {
        stack.spacing = try Self.number(value, min: 0)
      } else if key == "flex-direction" {
        guard ["row", "column"].contains(value) else {
          throw InspectorError.invalid("Native stacks support row or column")
        }
        Self.orient(stack, value == "row" ? .horizontal : .vertical)
      } else if key == "align-items" {
        try Self.align(stack, value)
      } else if key == "justify-content" {
        guard ["normal", "space-between"].contains(value) else {
          throw InspectorError.invalid(
            "Native distribution supports normal (gravity areas) or space-between (equal spacing)")
        }
        stack.distribution = value == "space-between" ? .equalSpacing : .gravityAreas
      } else if key == "padding" {
        let values = try Self.tokens(value).map { try Self.number($0, min: 0) }
        guard (1...4).contains(values.count) else {
          throw InspectorError.invalid("Padding takes one to four lengths")
        }
        stack.edgeInsets = NSEdgeInsets(
          top: values[0],
          left: values.count == 4 ? values[3] : values.count > 1 ? values[1] : values[0],
          bottom: values.count > 2 ? values[2] : values[0],
          right: values.count > 1 ? values[1] : values[0])
      } else {
        let length = try Self.number(value, min: 0)
        var insets = stack.edgeInsets
        if key == "padding-top" { insets.top = length }
        if key == "padding-right" { insets.right = length }
        if key == "padding-bottom" { insets.bottom = length }
        if key == "padding-left" { insets.left = length }
        stack.edgeInsets = insets
      }
    default: throw InspectorError.invalid("Unsupported native style: \(key)")
    }
  }

  private static let imagePositions: [String: NSImageAlignment] = [
    "center": .alignCenter, "top": .alignTop, "bottom": .alignBottom, "left": .alignLeft,
    "right": .alignRight, "left top": .alignTopLeft, "top left": .alignTopLeft,
    "right top": .alignTopRight, "top right": .alignTopRight,
    "left bottom": .alignBottomLeft, "bottom left": .alignBottomLeft,
    "right bottom": .alignBottomRight, "bottom right": .alignBottomRight,
  ]

  private static func decorationStyle(_ value: String) throws -> Int {
    let styles = [
      "solid": NSUnderlineStyle.single.rawValue, "double": NSUnderlineStyle.double.rawValue,
      "dotted": NSUnderlineStyle.single.rawValue | NSUnderlineStyle.patternDot.rawValue,
      "dashed": NSUnderlineStyle.single.rawValue | NSUnderlineStyle.patternDash.rawValue,
    ]
    guard let style = styles[value] else {
      throw InspectorError.invalid("Use solid, double, dotted or dashed")
    }
    return style
  }

  private static func stackAlignment(_ stack: NSStackView) -> String? {
    switch stack.alignment {
    case .left, .leading, .top: return "flex-start"
    case .right, .trailing, .bottom: return "flex-end"
    case .centerX, .centerY: return "center"
    case .firstBaseline: return "first baseline"
    case .lastBaseline: return "last baseline"
    default: return nil
    }
  }

  private static func orient(_ stack: NSStackView, _ orientation: NSUserInterfaceLayoutOrientation)
  {
    let old = stackAlignment(stack)
    stack.orientation = orientation
    if let old {
      if orientation == .vertical && old.contains("baseline") {
        stack.alignment = .leading
      } else {
        try? align(stack, old)
      }
    }
  }

  private static func align(_ stack: NSStackView, _ value: String) throws {
    switch value {
    case "start", "flex-start": stack.alignment = stack.orientation == .horizontal ? .top : .leading
    case "end", "flex-end": stack.alignment = stack.orientation == .horizontal ? .bottom : .trailing
    case "center": stack.alignment = stack.orientation == .horizontal ? .centerY : .centerX
    case "baseline", "first baseline", "last baseline":
      guard stack.orientation == .horizontal else {
        throw InspectorError.invalid("Baseline alignment requires a horizontal stack")
      }
      stack.alignment = value == "last baseline" ? .lastBaseline : .firstBaseline
    default: throw InspectorError.invalid("Use flex-start, flex-end, center or baseline alignment")
    }
  }

  private static func number(
    _ value: String, min: Double = -10000, max: Double = 10000, length: Bool = true
  ) throws
    -> CGFloat
  {
    let trimmed = value.trimmingCharacters(in: .whitespaces)
    let numeric = length && trimmed.hasSuffix("px") ? String(trimmed.dropLast(2)) : trimmed
    guard let number = Double(numeric), number.isFinite, number >= min, number <= max else {
      throw InspectorError.invalid("Use a finite numeric value or px length within native bounds")
    }
    return CGFloat(number)
  }

  private static func tokens(_ value: String) -> [String] {
    let expression = try! NSRegularExpression(pattern: "[^\\s()]+\\([^)]*\\)|[^\\s]+")
    return expression.matches(in: value, range: NSRange(value.startIndex..., in: value)).compactMap
    {
      Range($0.range, in: value).map { String(value[$0]) }
    }
  }

  private static func transform(_ value: String) throws -> CGAffineTransform {
    if value == "none" { return .identity }
    let expression = try! NSRegularExpression(pattern: "([a-zA-Z]+)\\(([^)]*)\\)")
    let matches = expression.matches(in: value, range: NSRange(value.startIndex..., in: value))
    guard !matches.isEmpty, matches.count <= 32 else {
      throw InspectorError.invalid("Use a finite 2D native transform")
    }
    var remainder = value
    var result = CGAffineTransform.identity
    for match in matches.reversed() {
      if let range = Range(match.range, in: remainder) { remainder.removeSubrange(range) }
    }
    guard remainder.trimmingCharacters(in: .whitespaces).isEmpty else {
      throw InspectorError.invalid("Invalid transform syntax")
    }
    for match in matches {
      let function = String(value[Range(match.range(at: 1), in: value)!])
      let args = value[Range(match.range(at: 2), in: value)!].split(whereSeparator: {
        $0 == "," || $0.isWhitespace
      }).map(String.init)
      let matrix: CGAffineTransform
      switch function {
      case "matrix":
        guard args.count == 6 else { throw InspectorError.invalid("matrix() takes six numbers") }
        let n = try args.map { try number($0, length: false) }
        matrix = CGAffineTransform(a: n[0], b: n[1], c: n[2], d: n[3], tx: n[4], ty: n[5])
      case "translate", "translateX", "translateY":
        guard (1...2).contains(args.count), function == "translate" || args.count == 1 else {
          throw InspectorError.invalid("Invalid translation")
        }
        let x = function == "translateY" ? 0 : try number(args[0])
        let y =
          function == "translateY" ? try number(args[0]) : args.count == 2 ? try number(args[1]) : 0
        matrix = CGAffineTransform(translationX: x, y: y)
      case "scale", "scaleX", "scaleY":
        guard (1...2).contains(args.count), function == "scale" || args.count == 1 else {
          throw InspectorError.invalid("Invalid scale")
        }
        let n = try number(args[0], min: -100, max: 100, length: false)
        matrix = CGAffineTransform(
          scaleX: function == "scaleY" ? 1 : n,
          y: function == "scaleX"
            ? 1 : args.count == 2 ? try number(args[1], min: -100, max: 100, length: false) : n)
      case "rotate", "skewX", "skewY":
        guard args.count == 1 else {
          throw InspectorError.invalid("Angle transforms take one angle")
        }
        let text = args[0]
        let angle: CGFloat
        if text.hasSuffix("deg") {
          angle = try number(String(text.dropLast(3)), min: -36000, max: 36000) * .pi / 180
        } else if text.hasSuffix("rad") {
          angle = try number(String(text.dropLast(3)))
        } else if text.hasSuffix("turn") {
          angle = try number(String(text.dropLast(4)), min: -100, max: 100) * 2 * .pi
        } else if text == "0" {
          angle = 0
        } else {
          throw InspectorError.invalid("Angles require deg, rad or turn")
        }
        if function == "rotate" {
          matrix = CGAffineTransform(rotationAngle: angle)
        } else {
          matrix = CGAffineTransform(
            a: 1, b: function == "skewY" ? tan(angle) : 0, c: function == "skewX" ? tan(angle) : 0,
            d: 1, tx: 0, ty: 0)
        }
      default: throw InspectorError.invalid("Unsupported 2D transform: \(function)")
      }
      result = matrix.concatenating(result)
      guard
        [result.a, result.b, result.c, result.d, result.tx, result.ty].allSatisfy({
          $0.isFinite && abs($0) <= 1_000_000
        })
      else { throw InspectorError.invalid("Transform exceeds native bounds") }
    }
    return result
  }

  static func color(_ color: NSColor?) -> String {
    guard let c = color?.usingColorSpace(.deviceRGB) else { return "rgba(0, 0, 0, 0)" }
    return
      "rgba(\(Int((c.redComponent * 255).rounded())), \(Int((c.greenComponent * 255).rounded())), \(Int((c.blueComponent * 255).rounded())), \(c.alphaComponent))"
  }

  static func parseColor(_ input: String) throws -> NSColor {
    let value = input.trimmingCharacters(in: .whitespaces).lowercased()
    let names: [String: NSColor] = [
      "red": .red, "blue": .blue,
      "green": NSColor(red: 0, green: 128.0 / 255, blue: 0, alpha: 1), "lime": .green,
      "white": .white, "black": .black, "transparent": .clear, "orange": .orange, "purple": .purple,
      "gray": .gray, "grey": .gray, "yellow": .yellow, "cyan": .cyan, "magenta": .magenta,
      "indianred": NSColor(red: 0.804, green: 0.361, blue: 0.361, alpha: 1),
    ]
    if let named = names[value] { return named }
    if value.hasPrefix("#") {
      var hex = String(value.dropFirst())
      if hex.count == 3 || hex.count == 4 { hex = hex.map { "\($0)\($0)" }.joined() }
      if hex.count == 6 || hex.count == 8, let number = UInt64(hex, radix: 16) {
        let alpha = hex.count == 8 ? CGFloat(number & 255) / 255 : 1
        let rgb = hex.count == 8 ? number >> 8 : number
        return NSColor(
          red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
          blue: CGFloat(rgb & 255) / 255, alpha: alpha)
      }
    }
    if value.hasPrefix("rgb(") || value.hasPrefix("rgba("), value.hasSuffix(")"),
      let open = value.firstIndex(of: "(")
    {
      let parts = value[value.index(after: open)..<value.index(before: value.endIndex)].split(
        whereSeparator: { $0 == "," || $0 == "/" || $0.isWhitespace })
      if parts.count == 3 || parts.count == 4 {
        let numbers = try parts.enumerated().map { index, part -> CGFloat in
          let percent = part.hasSuffix("%")
          let n = try number(
            String(percent ? part.dropLast() : part[...]), min: 0,
            max: percent ? 100 : index == 3 ? 1 : 255, length: false)
          return percent ? n / 100 : index == 3 ? n : n / 255
        }
        return NSColor(
          red: numbers[0], green: numbers[1], blue: numbers[2],
          alpha: numbers.count == 4 ? numbers[3] : 1)
      }
    }
    throw InspectorError.invalid("Use a supported color name, hex or rgb/rgba")
  }

  static func snapshot(_ view: NSView) -> [String: String] {
    let layer = view.layer
    var values = [
      "opacity": "\(view.alphaValue)", "visibility": view.isHidden ? "hidden" : "visible",
      "color-scheme": view.appearance == nil
        ? "normal"
        : view.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
          ? "dark" : "light",
      "background-color": color(layer?.backgroundColor.flatMap { NSColor(cgColor: $0) }),
      "border-radius": "\(layer?.cornerRadius ?? 0)px",
      "border-width": "\(layer?.borderWidth ?? 0)px",
      "border-color": color(layer?.borderColor.flatMap { NSColor(cgColor: $0) }),
      "border-style": (layer?.borderWidth ?? 0) > 0 ? "solid" : "none",
      "overflow": layer?.masksToBounds == true ? "hidden" : "visible",
      "z-index": "\(layer?.zPosition ?? 0)",
    ]
    let z = layer?.zPosition ?? 0
    values["z-index"] = z.isFinite && z.rounded() == z && abs(z) <= 10000 ? String(Int(z)) : nil
    if let layer, layer.shadowOpacity > 0 {
      let original = layer.shadowColor.flatMap { NSColor(cgColor: $0) } ?? .black
      let c = original.withAlphaComponent(original.alphaComponent * CGFloat(layer.shadowOpacity))
      values["box-shadow"] =
        "\(layer.shadowOffset.width)px \(view.isFlipped ? layer.shadowOffset.height : -layer.shadowOffset.height)px \(layer.shadowRadius * 2)px \(color(c))"
    } else {
      values["box-shadow"] = "none"
    }
    if let layer, CATransform3DIsAffine(layer.transform) {
      let t = layer.affineTransform()
      values["transform"] =
        t.isIdentity ? "none" : "matrix(\(t.a), \(t.b), \(t.c), \(t.d), \(t.tx), \(t.ty))"
    } else if layer == nil {
      values["transform"] = "none"
    }
    if let field = view as? NSTextField {
      values["color"] = color(attribute(view, .foregroundColor) as? NSColor ?? field.textColor)
      if field.drawsBackground { values["background-color"] = color(field.backgroundColor) }
      values["white-space"] = field.cell?.wraps == true ? "normal" : "nowrap"
      values["text-overflow"] = field.lineBreakMode == .byTruncatingTail ? "ellipsis" : "clip"
      values["overflow-wrap"] = field.lineBreakMode == .byCharWrapping ? "anywhere" : "normal"
      values["-webkit-line-clamp"] =
        field.maximumNumberOfLines == 0 ? "none" : "\(field.maximumNumberOfLines)"
      values["user-select"] = field.isSelectable ? "text" : "none"
    }
    if let text = view as? NSTextView {
      values["color"] = color(text.textColor)
      if text.drawsBackground { values["background-color"] = color(text.backgroundColor) }
      values["user-select"] = text.isSelectable ? "text" : "none"
      values["caret-color"] = color(text.insertionPointColor)
    }
    if let button = view as? NSButton {
      values["color"] = color(
        attribute(view, .foregroundColor) as? NSColor ?? button.contentTintColor ?? .labelColor)
      values["accent-color"] = button.contentTintColor.map(color) ?? "auto"
    }
    if let font = font(view) {
      values["font-size"] = "\(font.pointSize)px"
      values["font-family"] = font.fontName
      let weight =
        (font.fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any])?[.weight]
        as? NSNumber
      let weights: [(String, NSFont.Weight)] = [
        ("100", .ultraLight), ("200", .thin), ("300", .light), ("400", .regular), ("500", .medium),
        ("600", .semibold), ("700", .bold), ("800", .heavy), ("900", .black),
      ]
      let fallback =
        NSFontManager.shared.traits(of: font).contains(.boldFontMask)
        ? Double(NSFont.Weight.bold.rawValue) : 0
      values["font-weight"] =
        weights.min {
          abs(Double($0.1.rawValue) - (weight?.doubleValue ?? fallback))
            < abs(Double($1.1.rawValue) - (weight?.doubleValue ?? fallback))
        }?.0
      values["font-style"] =
        NSFontManager.shared.traits(of: font).contains(.italicFontMask) ? "italic" : "normal"
    }
    if attributed(view) != nil {
      let paragraph =
        attribute(view, .paragraphStyle) as? NSParagraphStyle
        ?? (view as? NSTextView)?.defaultParagraphStyle
      let alignment =
        paragraph?.alignment ?? (view as? NSControl)?.alignment ?? (view as? NSTextView)?.alignment
        ?? .natural
      values["text-align"] =
        [
          .left: "left", .right: "right", .center: "center", .justified: "justify",
          .natural: "start",
        ][alignment]
      values["letter-spacing"] = "\((attribute(view, .kern) as? NSNumber)?.doubleValue ?? 0)px"
      values["line-height"] =
        (paragraph?.minimumLineHeight ?? 0) > 0 ? "\(paragraph!.minimumLineHeight)px" : "normal"
      values["text-indent"] = "\(paragraph?.firstLineHeadIndent ?? 0)px"
      values["direction"] = paragraph?.baseWritingDirection == .rightToLeft ? "rtl" : "ltr"
      values["hyphens"] = (paragraph?.hyphenationFactor ?? 0) > 0 ? "auto" : "none"
      let underline = attribute(view, .underlineStyle) as? Int ?? 0
      let strike = attribute(view, .strikethroughStyle) as? Int ?? 0
      values["text-decoration-line"] = [
        underline != 0 ? "underline" : "", strike != 0 ? "line-through" : "",
      ].filter { !$0.isEmpty }.joined(separator: " ")
      if values["text-decoration-line"] == "" { values["text-decoration-line"] = "none" }
      let style = underline != 0 ? underline : strike
      values["text-decoration-style"] =
        style & NSUnderlineStyle.patternDot.rawValue != 0
        ? "dotted"
        : style & NSUnderlineStyle.patternDash.rawValue != 0
          ? "dashed" : style & 0xf == NSUnderlineStyle.double.rawValue ? "double" : "solid"
      values["text-decoration-color"] = color(
        attribute(view, .underlineColor) as? NSColor ?? attribute(view, .strikethroughColor)
          as? NSColor ?? attribute(view, .foregroundColor) as? NSColor ?? (view as? NSTextField)?
          .textColor ?? .labelColor)
    }
    if let image = view as? NSImageView {
      values["accent-color"] = image.contentTintColor.map(color) ?? "auto"
      values["object-fit"] =
        [
          .scaleAxesIndependently: "fill", .scaleProportionallyDown: "scale-down",
          .scaleProportionallyUpOrDown: "contain", .scaleNone: "none",
        ][image.imageScaling]
      values["object-position"] = imagePositions.keys.sorted {
        $0.count < $1.count || ($0.count == $1.count && $0 < $1)
      }.first { imagePositions[$0] == image.imageAlignment }
    }
    if let stack = view as? NSStackView {
      values["gap"] = "\(stack.spacing)px"
      values["flex-direction"] = stack.orientation == .horizontal ? "row" : "column"
      values["align-items"] = stackAlignment(stack)
      if stack.distribution == .equalSpacing { values["justify-content"] = "space-between" }
      if stack.distribution == .gravityAreas { values["justify-content"] = "normal" }
      values["padding-top"] = "\(stack.edgeInsets.top)px"
      values["padding-right"] = "\(stack.edgeInsets.right)px"
      values["padding-bottom"] = "\(stack.edgeInsets.bottom)px"
      values["padding-left"] = "\(stack.edgeInsets.left)px"
    }
    return values
  }
}
#endif
