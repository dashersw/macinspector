// SPDX-License-Identifier: MIT
import AppKit
import MacInspector
import QuartzCore

final class FlippedView: NSView {
  override var isFlipped: Bool {
    true
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  var inspector: NativeInspector?
  var rows: [NSStackView] = []
  var narrowConstraints: [NSLayoutConstraint] = []

  var actionCount = 0
  var counter: NSTextField!
  var motion: NSView!
  var opacity: NSSlider!
  var progress: NSProgressIndicator!

  func label(
    _ text: String,
    size: CGFloat = 14,
    weight: NSFont.Weight = .regular,
    color: NSColor = .labelColor,
    id: String? = nil
  ) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    field.lineBreakMode = .byWordWrapping
    field.maximumNumberOfLines = 0
    if let id {
      field.identifier = .init(id)
    }

    return field
  }

  func stack(
    _ views: [NSView],
    axis: NSUserInterfaceLayoutOrientation = .vertical,
    spacing: CGFloat = 12
  ) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = axis
    stack.spacing = spacing
    stack.alignment = axis == .horizontal ? .centerY : .leading
    stack.translatesAutoresizingMaskIntoConstraints = false

    return stack
  }

  func card(_ title: String, symbol: String, id: String, contents: [NSView]) -> NSView {
    let card = FlippedView()
    card.identifier = .init(id)
    card.wantsLayer = true
    card.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    card.layer?.cornerRadius = 16

    let image = NSImageView(
      image: NSImage(systemSymbolName: symbol, accessibilityDescription: title)!)
    image.contentTintColor = .systemBlue
    image.widthAnchor.constraint(equalToConstant: 22).isActive = true
    image.heightAnchor.constraint(equalToConstant: 22).isActive = true

    let titleRow = stack(
      [image, label(title, size: 17, weight: .semibold)], axis: .horizontal, spacing: 9)
    let content = stack([titleRow] + contents, spacing: 16)
    card.addSubview(content)

    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 22),
      content.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -22),
      content.topAnchor.constraint(equalTo: card.topAnchor, constant: 20),
      content.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
    ])

    return card
  }

  func button(_ title: String, id: String, action: Selector) -> NSButton {
    let button = NSButton(title: title, target: self, action: action)
    button.bezelStyle = .rounded
    button.identifier = .init(id)

    return button
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1100, height: 880),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    window.title = "Native Mac Showcase"
    window.minSize = NSSize(width: 560, height: 520)
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.backgroundColor = .windowBackgroundColor

    let root = FlippedView()
    root.identifier = .init("surface")
    window.contentView = root

    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(scroll)

    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: root.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])

    let document = FlippedView()
    document.translatesAutoresizingMaskIntoConstraints = false
    scroll.documentView = document

    let heading = stack([
      label("Native Mac Surface", size: 30, weight: .semibold),
      label(
        "Real AppKit controls. Inspect and edit them live.", size: 15, color: .secondaryLabelColor),
    ])

    let hero = card(
      "AppKit, in its own process", symbol: "sparkles", id: "hero",
      contents: [
        label(
          "A native view tree, connected to Chrome DevTools.", size: 22, weight: .medium,
          color: .white, id: "hero-title"),
        label(
          "Pick an element in this window. Change its text, color or appearance.", size: 14,
          color: .white),
      ])
    hero.layer?.backgroundColor = NSColor.systemBlue.cgColor

    let text = NSTextField(string: "Hello from AppKit")
    text.identifier = .init("message-field")
    text.placeholderString = "Write a message"
    text.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true

    let notes = NSTextView(frame: .zero)
    notes.identifier = .init("notes-field")
    notes.string = "Multiline text\nEdit this in DevTools."
    notes.font = .systemFont(ofSize: 14)
    notes.textColor = .labelColor
    notes.drawsBackground = false
    notes.heightAnchor.constraint(equalToConstant: 52).isActive = true

    let choice = NSPopUpButton()
    choice.addItems(withTitles: ["San Francisco", "London", "Berlin", "Tokyo"])
    choice.identifier = .init("city-menu")

    let textCard = card(
      "Text & choices", symbol: "text.cursor", id: "text-card", contents: [text, notes, choice])

    let toggle = NSSwitch()
    toggle.state = .on
    toggle.identifier = .init("enabled-switch")

    let check = NSButton(checkboxWithTitle: "Remember my selection", target: nil, action: nil)
    check.state = .on
    check.identifier = .init("remember-checkbox")

    let segments = NSSegmentedControl(
      labels: ["Day", "Week", "Month"], trackingMode: .selectOne, target: nil, action: nil)
    segments.selectedSegment = 1
    segments.identifier = .init("period-segments")

    let toggleCard = card(
      "Switches & selection", symbol: "switch.2", id: "toggle-card",
      contents: [stack([label("Enabled"), toggle], axis: .horizontal), check, segments])

    opacity = NSSlider(
      value: 1, minValue: 0.2, maxValue: 1, target: self, action: #selector(adjustOpacity))
    opacity.identifier = .init("opacity-slider")
    opacity.isContinuous = true
    opacity.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true

    progress = NSProgressIndicator()
    progress.isIndeterminate = false
    progress.minValue = 0
    progress.maxValue = 100
    progress.doubleValue = 68
    progress.style = .bar
    progress.identifier = .init("progress")
    progress.widthAnchor.constraint(greaterThanOrEqualToConstant: 210).isActive = true

    let stepper = NSStepper()
    stepper.minValue = 0
    stepper.maxValue = 100
    stepper.doubleValue = 68
    stepper.target = self
    stepper.action = #selector(adjustProgress)
    stepper.identifier = .init("progress-stepper")

    let sliders = card(
      "Values & progress", symbol: "slider.horizontal.3", id: "values-card",
      contents: [
        stack([label("Tile opacity"), opacity], axis: .horizontal),
        stack([progress, stepper], axis: .horizontal),
      ])

    let color = NSColorWell()
    color.color = .systemBlue
    color.target = self
    color.action = #selector(changeColor)
    color.identifier = .init("tile-color")
    color.widthAnchor.constraint(equalToConstant: 72).isActive = true
    color.heightAnchor.constraint(equalToConstant: 28).isActive = true

    let date = NSDatePicker()
    date.datePickerStyle = .textFieldAndStepper
    date.datePickerElements = [.yearMonthDay]
    date.dateValue = Date()
    date.identifier = .init("date-picker")

    let pickers = card(
      "Native pickers", symbol: "calendar", id: "pickers-card",
      contents: [stack([label("Accent color"), color], axis: .horizontal), date])

    motion = FlippedView()
    motion.identifier = .init("animated-tile")
    motion.wantsLayer = true
    motion.layer?.backgroundColor = NSColor.systemBlue.cgColor
    motion.layer?.cornerRadius = 14
    let tileWidth = motion.widthAnchor.constraint(equalToConstant: 64)
    tileWidth.identifier = "animated-tile.width"
    tileWidth.isActive = true
    let tileHeight = motion.heightAnchor.constraint(equalToConstant: 64)
    tileHeight.identifier = "animated-tile.height"
    tileHeight.isActive = true

    let star = NSImageView(
      image: NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Animated tile")!)
    star.contentTintColor = .white
    star.translatesAutoresizingMaskIntoConstraints = false
    motion.addSubview(star)

    NSLayoutConstraint.activate([
      star.centerXAnchor.constraint(equalTo: motion.centerXAnchor),
      star.centerYAnchor.constraint(equalTo: motion.centerYAnchor),
      star.widthAnchor.constraint(equalToConstant: 34),
      star.heightAnchor.constraint(equalToConstant: 34),
    ])

    let motionCard = card(
      "Layers & motion", symbol: "rectangle.3.group", id: "motion-card",
      contents: [
        stack(
          [
            motion,
            stack([
              button("Animate tile", id: "animate-button", action: #selector(animate)),
              button("Change corners", id: "corners-button", action: #selector(corners)),
            ]),
          ], axis: .horizontal, spacing: 20)
      ])

    counter = label("Actions: 0", size: 16, weight: .medium, id: "action-counter")
    let actionCard = card(
      "Native actions", symbol: "cursorarrow.click", id: "actions-card",
      contents: [
        counter,
        stack(
          [
            button("Add an action", id: "count-button", action: #selector(increment)),
            button("Reset", id: "reset-button", action: #selector(reset)),
          ], axis: .horizontal),
      ])

    let pairs = [[textCard, toggleCard], [sliders, pickers], [motionCard, actionCard]]
    rows = pairs.map { pair in
      let row = stack(pair, axis: .horizontal, spacing: 18)
      row.distribution = .fillEqually
      narrowConstraints += pair.map { $0.widthAnchor.constraint(equalTo: row.widthAnchor) }
      return row
    }

    let contents = stack([heading, hero] + rows, spacing: 18)
    for view in contents.arrangedSubviews {
      view.widthAnchor.constraint(equalTo: contents.widthAnchor).isActive = true
    }

    document.addSubview(contents)

    NSLayoutConstraint.activate([
      document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
      contents.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 28),
      contents.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -28),
      contents.topAnchor.constraint(equalTo: document.topAnchor, constant: 28),
      contents.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -28),
    ])

    let menu = NSMenu()
    let item = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "Quit Native Mac Showcase", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    item.submenu = appMenu
    menu.addItem(item)
    NSApp.mainMenu = menu

    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    updateLayout()

    inspector = NativeInspector(window: window)
    do {
      let port = UInt16(ProcessInfo.processInfo.environment["MACINSPECTOR_NATIVE_PORT"] ?? "0") ?? 0
      try inspector?.start(
        port: port, token: ProcessInfo.processInfo.environment["MACINSPECTOR_TOKEN"])
    } catch {
      fputs("Inspector: \(error.localizedDescription)\n", stderr)
    }

  }

  func applicationWillTerminate(_ notification: Notification) {
    inspector?.stop()
  }

  func updateLayout() {
    let narrow = (window.contentView?.bounds.width ?? 1100) < 780

    if narrow {
      NSLayoutConstraint.activate(narrowConstraints)
    } else {
      NSLayoutConstraint.deactivate(narrowConstraints)
    }

    for row in rows {
      row.orientation = narrow ? .vertical : .horizontal
      row.alignment = narrow ? .leading : .top
    }
  }

  func windowDidResize(_ notification: Notification) {
    updateLayout()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  @objc func increment() {
    incrementCount()
    counter.stringValue = "Actions: \(actionCount)"
  }

  private func incrementCount() {
    actionCount += 1
  }

  @objc func reset() {
    actionCount = 0
    counter.stringValue = "Actions: 0"
    motion.alphaValue = 1
    opacity.doubleValue = 1
    progress.doubleValue = 68
    motion.layer?.cornerRadius = 14
  }

  @objc func adjustOpacity(_ sender: NSSlider) {
    motion.alphaValue = sender.doubleValue
  }

  @objc func adjustProgress(_ sender: NSStepper) {
    progress.doubleValue = sender.doubleValue
  }

  @objc func changeColor(_ sender: NSColorWell) {
    motion.layer?.backgroundColor = sender.color.cgColor
  }

  @objc func corners() {
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.35
      motion.layer?.cornerRadius = motion.layer?.cornerRadius == 14 ? 30 : 14
    }
  }

  @objc func animate() {
    guard let layer = motion.layer else { return }

    let pulse = CABasicAnimation(keyPath: "transform.scale")
    pulse.fromValue = 1
    pulse.toValue = 1.18
    pulse.autoreverses = true
    pulse.duration = 0.3
    pulse.repeatCount = 2
    pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    layer.add(pulse, forKey: "pulse")
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()

app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
