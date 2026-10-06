// SPDX-License-Identifier: MIT
import AppKit
import QuartzCore
import XCTest

@testable import MacInspector

final class StyleTests: XCTestCase {
  private func fixture(_ view: NSView) -> (NSWindow, NativeInspector, Int) {
    _ = NSApplication.shared
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 500, height: 400), styleMask: [.titled],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    view.frame = NSRect(x: 40, y: 40, width: 250, height: 160)
    view.identifier = .init("subject")
    window.contentView!.addSubview(view)
    let inspector = NativeInspector(window: window)
    let nodes = inspector.snapshot()["nodes"] as! [[String: Any]]
    let id =
      nodes.first { ($0["attributes"] as? [String: String])?["id"] == "subject" }!["id"] as! Int
    return (window, inspector, id)
  }

  private func edit(_ inspector: NativeInspector, _ id: Int, _ values: [(String, String)]) throws {
    _ = try inspector.handle(
      "styles", ["node": id, "operations": values.map { ["key": $0.0, "value": $0.1] }])
  }

  private func reset(_ inspector: NativeInspector, _ id: Int, _ keys: [String]) throws {
    _ = try inspector.handle(
      "styles",
      ["node": id, "operations": keys.map { ["key": $0, "reset": true] as [String: Any] }])
  }

  func testLayerEditsRestoreTypedValuesAndKeepOtherDeclarations() throws {
    let view = NSView()
    view.wantsLayer = true
    view.layer!.borderWidth = 2
    view.layer!.borderColor = nil
    view.layer!.shadowColor = NSColor.blue.cgColor
    view.layer!.shadowOpacity = 0.3
    view.layer!.shadowRadius = 8
    view.layer!.shadowOffset = CGSize(width: 4, height: 5)
    view.layer!.zPosition = 2
    let (window, inspector, id) = fixture(view)
    defer {
      inspector.stop()
      window.close()
    }
    // AppKit can initialize backing-layer properties when attaching a view.
    view.layer!.shadowOpacity = 0.3
    let baseline = NativeStyles.snapshot(view)
    let originalColor = view.layer!.shadowColor
    try edit(
      inspector, id,
      [
        ("border", "3px solid red"), ("box-shadow", "4px 6px 12px rgba(0, 0, 0, 0.5)"),
        ("overflow", "hidden"), ("transform", "translate(12px, 8px) scale(2)"), ("z-index", "9"),
      ])
    XCTAssertEqual(view.layer!.borderWidth, 3)
    XCTAssertEqual(view.layer!.shadowOffset, CGSize(width: 4, height: -6))
    XCTAssertEqual(view.layer!.shadowRadius, 6)
    XCTAssertEqual(view.layer!.shadowOpacity, 0.5)
    XCTAssertTrue(view.layer!.masksToBounds)
    XCTAssertEqual(view.layer!.affineTransform().tx, 12, accuracy: 0.001)
    XCTAssertEqual(view.layer!.affineTransform().a, 2, accuracy: 0.001)
    XCTAssertEqual(view.layer!.zPosition, 9)
    try edit(inspector, id, [("border-width", "7px")])
    XCTAssertEqual(view.layer!.borderWidth, 7)
    try reset(inspector, id, ["border-width"])
    XCTAssertEqual(view.layer!.borderWidth, 3)
    try reset(inspector, id, ["border"])
    XCTAssertEqual(view.layer!.borderWidth, 2)
    XCTAssertNil(view.layer!.borderColor)
    XCTAssertEqual(view.layer!.shadowOpacity, 0.5)
    try reset(inspector, id, ["box-shadow", "overflow", "transform", "z-index"])
    XCTAssertEqual(NativeStyles.snapshot(view), baseline)
    XCTAssertEqual(view.layer!.shadowColor, originalColor)
  }

  func testFailedTransactionRestoresLayerCreationAndPreviousEdits() throws {
    let view = NSView()
    let (window, inspector, id) = fixture(view)
    defer {
      inspector.stop()
      window.close()
    }
    let originalWantsLayer = view.wantsLayer
    XCTAssertThrowsError(
      try edit(inspector, id, [("border", "5px solid red"), ("transform", "rotate(NaNdeg)")]))
    XCTAssertEqual(view.wantsLayer, originalWantsLayer)
    XCTAssertEqual(NativeStyles.snapshot(view)["border-width"], "0.0px")
    try edit(inspector, id, [("box-shadow", "1px 2px 4px blue")])
    let snapshot = NativeStyles.snapshot(view)
    XCTAssertThrowsError(try edit(inspector, id, [("border-width", "9px"), ("padding", "4px")]))
    XCTAssertEqual(NativeStyles.snapshot(view), snapshot)
    try reset(inspector, id, ["box-shadow"])
    XCTAssertEqual(view.wantsLayer, originalWantsLayer)
  }

  func testFontsComposeAndIndividualResetsPreserveOtherTraits() throws {
    let field = NSTextField(labelWithString: "Native fonts")
    field.font = NSFont(name: "Helvetica", size: 15)
    let original = field.font!
    let (window, inspector, id) = fixture(field)
    defer {
      inspector.stop()
      window.close()
    }
    try edit(
      inspector, id, [("font-size", "24px"), ("font-weight", "700"), ("font-style", "italic")])
    XCTAssertEqual(field.font!.pointSize, 24)
    XCTAssertTrue(NSFontManager.shared.traits(of: field.font!).contains(.boldFontMask))
    XCTAssertTrue(NSFontManager.shared.traits(of: field.font!).contains(.italicFontMask))
    XCTAssertEqual(NativeStyles.snapshot(field)["font-weight"], "700")
    try reset(inspector, id, ["font-size"])
    XCTAssertEqual(field.font!.pointSize, 15)
    XCTAssertTrue(NSFontManager.shared.traits(of: field.font!).contains(.boldFontMask))
    XCTAssertTrue(NSFontManager.shared.traits(of: field.font!).contains(.italicFontMask))
    try edit(inspector, id, [("font-family", "Times")])
    XCTAssertTrue(field.font!.familyName!.contains("Times"))
    XCTAssertTrue(NSFontManager.shared.traits(of: field.font!).contains(.boldFontMask))
    try reset(inspector, id, ["font-family", "font-weight", "font-style"])
    XCTAssertEqual(field.font, original)
    field.font = .boldSystemFont(ofSize: 15)
    try edit(inspector, id, [("font-weight", "normal")])
    XCTAssertFalse(NSFontManager.shared.traits(of: field.font!).contains(.boldFontMask))
    try reset(inspector, id, ["font-weight"])
    XCTAssertTrue(NSFontManager.shared.traits(of: field.font!).contains(.boldFontMask))
    try edit(inspector, id, [("line-height", "1.5"), ("font-size", "20px")])
    let paragraph =
      field.attributedStringValue.attribute(.paragraphStyle, at: 0, effectiveRange: nil)
      as! NSParagraphStyle
    XCTAssertEqual(paragraph.minimumLineHeight, 30, "Relative line heights use the final font size")
  }

  func testRichTextRestoresFormattingWithoutRevertingNewText() throws {
    let field = NSTextField(labelWithString: "Mixed text")
    let rich = NSMutableAttributedString(
      string: "Mixed text",
      attributes: [.font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor.blue])
    rich.addAttribute(
      .font, value: NSFont.boldSystemFont(ofSize: 18), range: NSRange(location: 0, length: 5))
    field.attributedStringValue = rich
    let original = field.attributedStringValue
    let (window, inspector, id) = fixture(field)
    defer {
      inspector.stop()
      window.close()
    }
    try edit(inspector, id, [("letter-spacing", "2px"), ("font-size", "22px"), ("color", "red")])
    XCTAssertEqual(
      (field.attributedStringValue.attribute(.font, at: 7, effectiveRange: nil) as! NSFont)
        .pointSize, 22)
    XCTAssertEqual(
      field.attributedStringValue.attribute(.foregroundColor, at: 0, effectiveRange: nil)
        as? NSColor, .red)
    try reset(inspector, id, ["letter-spacing", "font-size", "color"])
    XCTAssertTrue(field.attributedStringValue.isEqual(to: original))
    try edit(inspector, id, [("letter-spacing", "3px")])
    field.stringValue = "Updated while inspecting"
    try reset(inspector, id, ["letter-spacing"])
    XCTAssertEqual(field.stringValue, "Updated while inspecting")
  }

  func testParagraphsAndDecorationsUseActualAttributedText() throws {
    let field = NSTextField(wrappingLabelWithString: "Decorated paragraph")
    let (window, inspector, id) = fixture(field)
    defer {
      inspector.stop()
      window.close()
    }
    let original = field.attributedStringValue
    try edit(
      inspector, id,
      [
        ("text-align", "justify"), ("line-height", "28px"), ("letter-spacing", "1.5px"),
        ("text-indent", "6px"), ("direction", "rtl"), ("hyphens", "auto"),
        ("text-decoration", "underline line-through dashed red"),
      ])
    let string = field.attributedStringValue
    let paragraph =
      string.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as! NSParagraphStyle
    XCTAssertEqual(paragraph.alignment, .justified)
    XCTAssertEqual(paragraph.minimumLineHeight, 28)
    XCTAssertEqual(paragraph.maximumLineHeight, 28)
    XCTAssertEqual(paragraph.firstLineHeadIndent, 6)
    XCTAssertEqual(paragraph.baseWritingDirection, .rightToLeft)
    XCTAssertEqual(paragraph.hyphenationFactor, 1)
    XCTAssertEqual(string.attribute(.kern, at: 0, effectiveRange: nil) as? Double, 1.5)
    let style = NSUnderlineStyle.single.rawValue | NSUnderlineStyle.patternDash.rawValue
    XCTAssertEqual(string.attribute(.underlineStyle, at: 0, effectiveRange: nil) as? Int, style)
    XCTAssertEqual(string.attribute(.strikethroughStyle, at: 0, effectiveRange: nil) as? Int, style)
    try edit(
      inspector, id, [("text-decoration-style", "double"), ("text-decoration-color", "blue")])
    XCTAssertEqual(
      field.attributedStringValue.attribute(.underlineStyle, at: 0, effectiveRange: nil) as? Int,
      NSUnderlineStyle.double.rawValue)
    try reset(
      inspector, id,
      [
        "text-align", "line-height", "letter-spacing", "text-indent", "direction", "hyphens",
        "text-decoration", "text-decoration-style", "text-decoration-color",
      ])
    XCTAssertTrue(field.attributedStringValue.isEqual(to: original))
  }

  func testWrappingSelectionAndClampRestoreNativeCellState() throws {
    let field = NSTextField(wrappingLabelWithString: "Several words that may wrap")
    field.maximumNumberOfLines = 3
    let baseline = NativeStyles.snapshot(field)
    let (window, inspector, id) = fixture(field)
    defer {
      inspector.stop()
      window.close()
    }
    try edit(
      inspector, id,
      [
        ("white-space", "nowrap"), ("text-overflow", "ellipsis"), ("-webkit-line-clamp", "1"),
        ("user-select", "text"),
      ])
    XCTAssertTrue(field.cell!.usesSingleLineMode)
    XCTAssertEqual(field.lineBreakMode, .byTruncatingTail)
    XCTAssertEqual(field.maximumNumberOfLines, 1)
    XCTAssertTrue(field.isSelectable)
    try reset(inspector, id, ["white-space"])
    XCTAssertEqual(
      field.lineBreakMode, .byTruncatingTail,
      "Removing nowrap must preserve the active truncation declaration")
    XCTAssertEqual(field.maximumNumberOfLines, 1)
    try edit(inspector, id, [("overflow-wrap", "anywhere")])
    XCTAssertEqual(field.lineBreakMode, .byCharWrapping)
    try reset(
      inspector, id, ["text-overflow", "overflow-wrap", "-webkit-line-clamp", "user-select"])
    XCTAssertEqual(NativeStyles.snapshot(field), baseline)
  }

  func testTextViewCaretAndAppearanceResetAndButtonTintStaysIndependent() throws {
    let text = NSTextView()
    text.string = "Editable text"
    text.font = .systemFont(ofSize: 14)
    let caret = text.insertionPointColor
    let (window, inspector, id) = fixture(text)
    defer {
      inspector.stop()
      window.close()
    }
    try edit(
      inspector, id,
      [
        ("color", "blue"), ("background", "#ff000040"), ("font-size", "18px"),
        ("caret-color", "red"), ("user-select", "none"),
      ])
    XCTAssertEqual(text.font?.pointSize, 18)
    XCTAssertEqual(text.insertionPointColor, .red)
    XCTAssertFalse(text.isSelectable)
    try reset(inspector, id, ["caret-color"])
    XCTAssertEqual(text.insertionPointColor, caret)
    XCTAssertEqual(text.font?.pointSize, 18)
    let button = NSButton(title: "Tint", target: nil, action: nil)
    let styles = NativeStyles(button)
    try styles.apply([["key": "accent-color", "value": "blue"], ["key": "color", "value": "red"]])
    XCTAssertEqual(button.contentTintColor, .blue)
    try styles.apply([["key": "color", "reset": true]])
    XCTAssertEqual(button.contentTintColor, .blue)
  }

  func testStackSpacingInsetsAndAlignmentComposeAndRestore() throws {
    let stack = NSStackView(views: [
      NSTextField(labelWithString: "First"), NSTextField(labelWithString: "Second"),
    ])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8
    stack.edgeInsets = NSEdgeInsets(top: 1, left: 2, bottom: 3, right: 4)
    let baseline = NativeStyles.snapshot(stack)
    let (window, inspector, id) = fixture(stack)
    defer {
      inspector.stop()
      window.close()
    }
    try edit(
      inspector, id,
      [
        ("flex-direction", "row"), ("align-items", "center"), ("gap", "24px"),
        ("padding", "10px 20px 30px 40px"), ("padding-left", "50px"),
        ("justify-content", "space-between"),
      ])
    XCTAssertEqual(stack.orientation, .horizontal)
    XCTAssertEqual(stack.alignment, .centerY)
    XCTAssertEqual(stack.spacing, 24)
    XCTAssertEqual(stack.edgeInsets.left, 50)
    XCTAssertEqual(stack.edgeInsets.bottom, 30)
    XCTAssertEqual(stack.distribution, .equalSpacing)
    try reset(inspector, id, ["padding-left", "flex-direction"])
    XCTAssertEqual(stack.edgeInsets.left, 40)
    XCTAssertEqual(stack.orientation, .vertical)
    XCTAssertEqual(stack.alignment, .centerX)
    XCTAssertEqual(stack.spacing, 24)
    try reset(inspector, id, ["align-items", "gap", "padding", "justify-content"])
    XCTAssertEqual(NativeStyles.snapshot(stack), baseline)
  }

  func testImageFittingPositionTintAndAppearanceReset() throws {
    let image = NSImageView(image: NSImage(size: NSSize(width: 30, height: 20)))
    let baseline = NativeStyles.snapshot(image)
    let (window, inspector, id) = fixture(image)
    defer {
      inspector.stop()
      window.close()
    }
    try edit(
      inspector, id,
      [
        ("object-fit", "contain"), ("object-position", "right bottom"), ("accent-color", "red"),
        ("color-scheme", "dark"),
      ])
    XCTAssertEqual(image.imageScaling, .scaleProportionallyUpOrDown)
    XCTAssertEqual(image.imageAlignment, .alignBottomRight)
    XCTAssertEqual(image.contentTintColor, .red)
    XCTAssertEqual(image.appearance?.name, .darkAqua)
    try reset(inspector, id, ["object-fit"])
    XCTAssertEqual(image.imageAlignment, .alignBottomRight)
    try reset(inspector, id, ["object-position", "accent-color", "color-scheme"])
    XCTAssertNil(image.appearance)
    XCTAssertEqual(NativeStyles.snapshot(image), baseline)
  }

  func testUnrelatedRuntimeAppearanceChangesSurviveEditingAndReset() throws {
    let view = NSView()
    view.wantsLayer = true
    let layerStyles = NativeStyles(view)
    try layerStyles.apply([["key": "background", "value": "red"]])
    view.layer!.cornerRadius = 30
    try layerStyles.apply([["key": "background", "value": "blue"]])
    XCTAssertEqual(view.layer!.cornerRadius, 30)
    try layerStyles.apply([["key": "background", "reset": true]])
    XCTAssertEqual(view.layer!.cornerRadius, 30)

    let field = NSTextField(labelWithString: "Dynamic text")
    let textStyles = NativeStyles(field)
    try textStyles.apply([["key": "font-size", "value": "20px"]])
    let changed = NSMutableAttributedString(attributedString: field.attributedStringValue)
    changed.addAttribute(
      .foregroundColor, value: NSColor.green, range: NSRange(location: 0, length: changed.length))
    field.attributedStringValue = changed
    try textStyles.apply([["key": "font-size", "value": "24px"]])
    XCTAssertEqual(
      field.attributedStringValue.attribute(.foregroundColor, at: 0, effectiveRange: nil)
        as? NSColor, .green)
    try textStyles.apply([["key": "font-size", "reset": true]])
    XCTAssertEqual(
      field.attributedStringValue.attribute(.foregroundColor, at: 0, effectiveRange: nil)
        as? NSColor, .green)

    let stack = NSStackView()
    stack.orientation = .vertical
    let stackStyles = NativeStyles(stack)
    try stackStyles.apply([["key": "gap", "value": "8px"]])
    stack.orientation = .horizontal
    try stackStyles.apply([["key": "gap", "value": "20px"]])
    XCTAssertEqual(stack.orientation, .horizontal)
    try stackStyles.apply([["key": "gap", "reset": true]])
    XCTAssertEqual(stack.orientation, .horizontal)
  }

  func testInvalidSyntaxAndWrongNativeTypesRejectWithoutChanges() throws {
    let view = NSView()
    view.wantsLayer = true
    let styles = NativeStyles(view)
    let baseline = NativeStyles.snapshot(view)
    for (key, value) in [
      ("transform", "rotate(10deg) trailing"), ("transform", "translate(10%)"),
      ("box-shadow", "1px 2px 3px 4px red"), ("border-style", "dashed"), ("z-index", "1.5"),
      ("gap", "10px"), ("object-fit", "cover"), ("opacity", "0.5pxjunk"), ("font-weight", "bold"),
      ("padding", "1px"),
    ] {
      XCTAssertThrowsError(try styles.apply([["key": key, "value": value]]), "\(key): \(value)")
      XCTAssertEqual(NativeStyles.snapshot(view), baseline)
    }
  }
}
