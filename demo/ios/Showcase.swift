import MacInspector
// SPDX-License-Identifier: MIT
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  private var inspector: NativeInspector?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = ShowcaseController()
    window.makeKeyAndVisible()
    self.window = window
    let inspector = NativeInspector(window: window)
    do {
      try inspector.start(
        port: UInt16(ProcessInfo.processInfo.environment["MACINSPECTOR_NATIVE_PORT"] ?? "0") ?? 0)
      self.inspector = inspector
    } catch { fatalError("Inspector startup failed: \(error)") }
    return true
  }
}

final class ShowcaseController: UIViewController {
  private var actionCount = 0
  private let counter = UILabel()
  private let tile = UIView()
  private let progress = UIProgressView(progressViewStyle: .default)
  private let message = UITextField()

  private func label(_ text: String, size: CGFloat = 15, weight: UIFont.Weight = .regular)
    -> UILabel
  {
    let label = UILabel()
    label.text = text
    label.font = .systemFont(ofSize: size, weight: weight)
    label.numberOfLines = 0
    return label
  }

  private func stack(
    _ views: [UIView], axis: NSLayoutConstraint.Axis = .vertical, spacing: CGFloat = 14
  ) -> UIStackView {
    let stack = UIStackView(arrangedSubviews: views)
    stack.axis = axis
    stack.spacing = spacing
    return stack
  }

  private func button(_ title: String, id: String, action: Selector) -> UIButton {
    let button = UIButton(type: .system)
    button.setTitle(title, for: .normal)
    button.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
    button.accessibilityIdentifier = id
    button.addTarget(self, action: action, for: .touchUpInside)
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 42).isActive = true
    return button
  }

  private func section(_ title: String, views: [UIView]) -> UIStackView {
    let section = stack([label(title, size: 20, weight: .semibold)] + views)
    section.backgroundColor = .secondarySystemGroupedBackground
    section.layer.cornerRadius = 18
    section.isLayoutMarginsRelativeArrangement = true
    section.layoutMargins = UIEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    return section
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemGroupedBackground
    let scroll = UIScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll)
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
    ])

    counter.accessibilityIdentifier = "action-counter"
    counter.text = "No actions yet"
    counter.font = .systemFont(ofSize: 15)
    counter.textColor = .secondaryLabel
    let countButton = button("Add an action", id: "count-button", action: #selector(increment))

    message.placeholder = "Write a message"
    message.borderStyle = .roundedRect
    message.accessibilityIdentifier = "message-field"
    message.addTarget(self, action: #selector(messageChanged), for: .editingChanged)

    let notes = UITextView()
    notes.accessibilityIdentifier = "notes-field"
    notes.text = "Multiline text\nEdit this in DevTools."
    notes.font = .systemFont(ofSize: 15)
    notes.backgroundColor = .secondarySystemBackground
    notes.layer.cornerRadius = 10
    notes.heightAnchor.constraint(equalToConstant: 64).isActive = true

    let toggle = UISwitch()
    toggle.isOn = true
    toggle.accessibilityIdentifier = "enabled-switch"
    toggle.addTarget(self, action: #selector(toggleChanged(_:)), for: .valueChanged)
    let toggleRow = stack([label("Animations"), toggle], axis: .horizontal)
    toggleRow.alignment = .center

    let segment = UISegmentedControl(items: ["Calm", "Bright", "Bold"])
    segment.selectedSegmentIndex = 0
    segment.accessibilityIdentifier = "theme-segment"
    segment.addTarget(self, action: #selector(themeChanged(_:)), for: .valueChanged)
    let stepper = UIStepper()
    stepper.maximumValue = 20
    stepper.accessibilityIdentifier = "count-stepper"
    stepper.addTarget(self, action: #selector(stepperChanged(_:)), for: .valueChanged)
    let stepperRow = stack([label("Action count"), stepper], axis: .horizontal)
    stepperRow.alignment = .center

    tile.backgroundColor = .systemIndigo
    tile.layer.cornerRadius = 14
    tile.accessibilityIdentifier = "animated-tile"
    let width = tile.widthAnchor.constraint(equalToConstant: 72)
    width.identifier = "tile.width"
    let height = tile.heightAnchor.constraint(equalToConstant: 72)
    height.identifier = "tile.height"
    NSLayoutConstraint.activate([width, height])
    let motionRow = stack(
      [tile, button("Animate", id: "animate-button", action: #selector(animate))],
      axis: .horizontal, spacing: 20)
    motionRow.alignment = .center

    let slider = UISlider()
    slider.value = 1
    slider.accessibilityIdentifier = "opacity-slider"
    slider.addTarget(self, action: #selector(opacityChanged(_:)), for: .valueChanged)
    progress.progress = 0.65
    progress.accessibilityIdentifier = "progress"

    let menu = UIButton(type: .system)
    menu.setTitle("Choose a city", for: .normal)
    menu.accessibilityIdentifier = "city-menu"
    menu.showsMenuAsPrimaryAction = true
    menu.menu = UIMenu(
      title: "City",
      children: ["Berlin", "London", "Tokyo"].map { city in
        UIAction(title: city, identifier: UIAction.Identifier(city.lowercased())) { [weak menu] _ in
          menu?.setTitle(city, for: .normal)
        }
      })

    let date = UIDatePicker()
    date.datePickerMode = .date
    date.preferredDatePickerStyle = .compact
    date.accessibilityIdentifier = "date-picker"
    date.addTarget(self, action: #selector(dateChanged(_:)), for: .valueChanged)

    let content = stack(
      [
        label("Native iOS", size: 34, weight: .bold),
        label("UIKit controls. Live inspection.", size: 17),
        section("Actions", views: [counter, countButton, message, notes]),
        section("Controls", views: [toggleRow, segment, stepperRow, menu, date]),
        section(
          "Motion & appearance", views: [motionRow, label("Tile opacity"), slider, progress]),
      ], spacing: 20)
    content.accessibilityIdentifier = "showcase"
    content.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(content)
    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(
        equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20),
      content.trailingAnchor.constraint(
        equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
      content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 20),
      content.bottomAnchor.constraint(
        equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40),
    ])
  }

  private func incrementCount() {
    actionCount += 1
    counter.text = "\(actionCount) actions"
  }

  @objc func increment() {
    incrementCount()
    progress.setProgress(Float(actionCount % 11) / 10, animated: true)
  }

  @objc func messageChanged() { counter.text = message.text }

  @objc func toggleChanged(_ sender: UISwitch) { tile.isHidden = !sender.isOn }

  @objc func themeChanged(_ sender: UISegmentedControl) {
    tile.backgroundColor = [.systemIndigo, .systemOrange, .systemPink][sender.selectedSegmentIndex]
  }

  @objc func stepperChanged(_ sender: UIStepper) {
    actionCount = Int(sender.value)
    counter.text = "\(actionCount) actions"
  }

  @objc func opacityChanged(_ sender: UISlider) { tile.alpha = CGFloat(sender.value) }

  @objc func dateChanged(_ sender: UIDatePicker) {
    counter.text = sender.date.formatted(date: .abbreviated, time: .omitted)
  }

  @objc func animate() {
    UIView.animate(
      withDuration: 0.6, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0
    ) {
      self.tile.transform =
        self.tile.transform.isIdentity
        ? CGAffineTransform(rotationAngle: .pi / 8).scaledBy(x: 1.15, y: 1.15) : .identity
      self.tile.layer.cornerRadius = self.tile.layer.cornerRadius == 14 ? 36 : 14
    }
  }
}
