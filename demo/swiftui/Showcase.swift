// SPDX-License-Identifier: MIT
import MacInspector
import SwiftUI

@MainActor
final class ShowcaseModel: ObservableObject {
  #if os(macOS)
    @Published var title = "Native Mac Surface"
  #else
    @Published var title = "Native iOS Surface"
  #endif
  @Published var message = "Hello from SwiftUI"
  @Published var notes = "Multiline text\nEdit this in DevTools."
  @Published var enabled = true
  @Published var remember = true
  @Published var period = "Week"
  @Published var city = "San Francisco"
  @Published var count = 0
  @Published var opacity = 1.0
  @Published var progress = 68.0
  @Published var date = Date()
  @Published var tint = ShowcasePalette.blue
  @Published var radius = 14.0
  @Published var tileWidth = 64.0
  @Published var tileHeight = 64.0
  @Published var fontSize = 30.0
  @Published var titleColor = Color.primary

  func increment() {
    incrementCount()
  }

  func incrementCount() {
    count += 1
  }

  func animate() {
    withAnimation(.easeInOut(duration: 0.5)) {
      radius = radius == 14 ? 36 : 14
      tileWidth = tileWidth == 64 ? 120 : 64
      tileHeight = tileHeight == 64 ? 96 : 64
      tint = radius == 36 ? .purple : ShowcasePalette.blue
    }
  }

  func changeCorners() {
    withAnimation(.easeInOut(duration: 0.35)) {
      radius = radius == 14 ? 30 : 14
    }
  }

  func reset() {
    count = 0
    opacity = 1
    radius = 14
    progress = 68
    tileWidth = 64
    tileHeight = 64
    tint = ShowcasePalette.blue
  }
}

struct ShowcaseView: View {
  @StateObject private var model = ShowcaseModel()

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        heading
        hero
        ShowcaseCards {
          textCard
          toggleCard
          valuesCard
          pickersCard
          motionCard
          actionsCard
        }
        .macInspector(id: "cards", tag: "SwiftUIShowcase.ShowcaseCards")
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(28)
      .macInspector(id: "showcase", tag: "SwiftUI.VStack")
    }
    .background(ShowcasePalette.surface)
    .tint(ShowcasePalette.blue)
  }

  private var heading: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(model.title)
        .font(.system(size: model.fontSize, weight: .semibold))
        .foregroundStyle(model.titleColor)
        .macInspector(
          id: "swiftui-title",
          properties: [
            .text($model.title),
            .numberStyle("font-size", $model.fontSize, range: 8...96),
            .color("color", $model.titleColor),
          ])
      Text("Real SwiftUI controls. Inspect and edit them live.")
        .font(.system(size: 15))
        .foregroundStyle(.secondary)
    }
    .macInspector(id: "page-header", tag: "SwiftUI.VStack")
  }

  private var hero: some View {
    ShowcaseCard("SwiftUI, in its own process", symbol: "sparkles", id: "hero", hero: true) {
      Text("A native view tree, connected to Chrome DevTools.")
        .font(.system(size: 22, weight: .medium))
        .macInspector(
          id: "hero-title",
          properties: [.text("A native view tree, connected to Chrome DevTools.")])
      if model.enabled {
        Text("Pick an element in this window. Change its text, color or appearance.")
          .font(.system(size: 14))
          .macInspector(
            id: "hero-description",
            properties: [
              .text("Pick an element in this window. Change its text, color or appearance.")
            ])
      } else {
        Text("Animations are paused. Turn on Enabled to run them.")
          .font(.system(size: 14))
          .macInspector(
            id: "paused-description",
            properties: [.text("Animations are paused. Turn on Enabled to run them.")])
      }
    }
  }

  private var textCard: some View {
    ShowcaseCard("Text & choices", symbol: "text.cursor", id: "text-card") {
      TextField("Write a message", text: $model.message)
        .textFieldStyle(.roundedBorder)
        .macInspector(id: "message-field", properties: [.value($model.message)])
      TextEditor(text: $model.notes)
        .font(.system(size: 14))
        .scrollContentBackground(.hidden)
        .frame(height: 52)
        .macInspector(id: "notes-field", properties: [.text($model.notes)])
      Picker("City", selection: $model.city) {
        ForEach(["San Francisco", "London", "Berlin", "Tokyo"], id: \.self) { Text($0) }
      }
      .pickerStyle(.menu)
      .labelsHidden()
      .fixedSize()
      .macInspector(
        id: "city-menu",
        properties: [.value($model.city, choices: ["San Francisco", "London", "Berlin", "Tokyo"])])
    }
  }

  private var toggleCard: some View {
    ShowcaseCard("Switches & selection", symbol: "switch.2", id: "toggle-card") {
      HStack(spacing: 12) {
        Text("Enabled").font(.system(size: 14))
        Toggle("Enabled", isOn: $model.enabled)
          .labelsHidden()
          .toggleStyle(.switch)
          .fixedSize()
          .macInspector(
            id: "enabled-switch", properties: [.checked($model.enabled), .text("Enabled")])
      }
      rememberSelection
        .macInspector(
          id: "remember-checkbox",
          properties: [.checked($model.remember), .text("Remember my selection")])
      Picker("Period", selection: $model.period) {
        ForEach(["Day", "Week", "Month"], id: \.self) { Text($0) }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .fixedSize()
      .macInspector(
        id: "period-segments",
        properties: [.value($model.period, choices: ["Day", "Week", "Month"])])
    }
  }

  private var rememberSelection: some View {
    #if os(macOS)
      Toggle("Remember my selection", isOn: $model.remember).toggleStyle(.checkbox)
    #else
      Toggle("Remember my selection", isOn: $model.remember)
    #endif
  }

  private var valuesCard: some View {
    ShowcaseCard("Values & progress", symbol: "slider.horizontal.3", id: "values-card") {
      HStack(spacing: 12) {
        Text("Tile opacity").font(.system(size: 14))
        Slider(value: $model.opacity, in: 0...1)
          .macInspector(id: "opacity-slider", properties: [.value($model.opacity, range: 0...1)])
      }
      HStack(spacing: 12) {
        ProgressView(value: model.progress, total: 100)
          .progressViewStyle(.linear)
          .macInspector(id: "progress", properties: [.value($model.progress, range: 0...100)])
        Stepper("Progress", value: $model.progress, in: 0...100)
          .labelsHidden()
          .fixedSize()
          .macInspector(
            id: "progress-stepper", properties: [.value($model.progress, range: 0...100)])
      }
    }
  }

  private var pickersCard: some View {
    ShowcaseCard("Native pickers", symbol: "calendar", id: "pickers-card") {
      HStack(spacing: 12) {
        Text("Accent color").font(.system(size: 14))
        ColorPicker("Accent color", selection: $model.tint)
          .labelsHidden()
          .frame(width: 72, height: 28, alignment: .leading)
          .macInspector(id: "tile-color", properties: [.color("accent-color", $model.tint)])
      }
      datePicker
        .labelsHidden()
        .fixedSize()
        .macInspector(id: "date-picker", properties: [.date($model.date)])
    }
  }

  private var datePicker: some View {
    #if os(macOS)
      DatePicker("Date", selection: $model.date, displayedComponents: .date).datePickerStyle(.field)
    #else
      DatePicker("Date", selection: $model.date, displayedComponents: .date).datePickerStyle(
        .compact)
    #endif
  }

  private var motionCard: some View {
    ShowcaseCard("Layers & motion", symbol: "rectangle.3.group", id: "motion-card") {
      HStack(spacing: 20) {
        RoundedRectangle(cornerRadius: model.radius)
          .fill(model.tint)
          .overlay {
            Image(systemName: "sparkles")
              .font(.system(size: 24))
              .foregroundStyle(.white)
          }
          .frame(width: model.tileWidth, height: model.tileHeight)
          .opacity(model.opacity)
          .macInspector(
            id: "animated-tile", tag: "SwiftUI.RoundedRectangle",
            properties: [
              .numberStyle("border-radius", $model.radius, range: 0...100),
              .numberStyle("width", $model.tileWidth, range: 0...300),
              .numberStyle("height", $model.tileHeight, range: 0...300),
              .numberStyle("opacity", $model.opacity, range: 0...1),
              .color("background-color", $model.tint),
            ])
        VStack(alignment: .leading, spacing: 12) {
          Button("Animate tile", action: model.animate)
            .disabled(!model.enabled)
            .macInspector(
              id: "animate-button", properties: [.text("Animate tile"), .enabled($model.enabled)],
              action: .init("animate", perform: model.animate))
          Button("Change corners", action: model.changeCorners)
            .macInspector(
              id: "corners-button", properties: [.text("Change corners")],
              action: .init("changeCorners", perform: model.changeCorners))
        }
      }
    }
  }

  private var actionsCard: some View {
    ShowcaseCard("Native actions", symbol: "cursorarrow.click", id: "actions-card") {
      Text("Actions: \(model.count)")
        .font(.system(size: 16, weight: .medium))
        .macInspector(id: "action-counter", properties: [.text("Actions: \(model.count)")])
      HStack(spacing: 12) {
        Button("Add an action", action: model.increment)
          .macInspector(
            id: "count-button", properties: [.text("Add an action")],
            action: .init("increment", perform: model.increment))
        Button("Reset", action: model.reset)
          .macInspector(
            id: "reset-button", properties: [.text("Reset")],
            action: .init("reset", perform: model.reset))
      }
    }
  }
}

private enum ShowcasePalette {
  #if os(macOS)
    // Let the AppKit window draw its native background behind the SwiftUI cards.
    static let surface = Color.clear
    static let card = Color(nsColor: .controlBackgroundColor)
    static let blue = Color(nsColor: .systemBlue)
  #else
    static let surface = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    static let blue = Color(uiColor: .systemBlue)
  #endif
}

private struct ShowcaseCard<Content: View>: View {
  let title: String
  let symbol: String
  let id: String
  let hero: Bool
  let content: Content
  @State private var background: Color
  @State private var radius = 16.0

  init(
    _ title: String, symbol: String, id: String, hero: Bool = false,
    @ViewBuilder content: () -> Content
  ) {
    self.title = title
    self.symbol = symbol
    self.id = id
    self.hero = hero
    self.content = content()
    _background = State(initialValue: hero ? ShowcasePalette.blue : ShowcasePalette.card)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 9) {
        Image(systemName: symbol)
          .font(.system(size: 18))
          .frame(width: 22, height: 22)
          .foregroundStyle(hero ? Color.white : ShowcasePalette.blue)
        Text(title)
          .font(.system(size: 17, weight: .semibold))
      }
      content
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .padding(.horizontal, 22)
    .padding(.vertical, 20)
    .foregroundStyle(hero ? Color.white : Color.primary)
    .background(background, in: RoundedRectangle(cornerRadius: radius))
    .macInspector(
      id: id, tag: "SwiftUIShowcase.Card",
      properties: [
        .color("background-color", $background),
        .numberStyle("border-radius", $radius, range: 0...100),
      ])
  }
}

/// A responsive public SwiftUI Layout; all demo controls remain mounted for inspection.
private struct ShowcaseCards: Layout {
  private let gap: CGFloat = 18

  // The content has 28-point insets, matching AppKit's 780-point window breakpoint.
  private func columns(_ width: CGFloat) -> Int { width >= 724 ? 2 : 1 }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? 640
    let count = columns(width)
    let cell = max(0, (width - gap * CGFloat(count - 1)) / CGFloat(count))
    var height: CGFloat = 0
    for start in stride(from: 0, to: subviews.count, by: count) {
      let row = subviews[start..<min(start + count, subviews.count)]
      let rowHeight = row.map { $0.sizeThatFits(.init(width: cell, height: nil)).height }.max() ?? 0
      if start > 0 { height += gap }
      height += rowHeight
    }
    return CGSize(width: width, height: height)
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    let count = columns(bounds.width)
    let cell = max(0, (bounds.width - gap * CGFloat(count - 1)) / CGFloat(count))
    var y = bounds.minY
    for start in stride(from: 0, to: subviews.count, by: count) {
      let row = subviews[start..<min(start + count, subviews.count)]
      let rowHeight = row.map { $0.sizeThatFits(.init(width: cell, height: nil)).height }.max() ?? 0
      for (offset, view) in row.enumerated() {
        view.place(
          at: .init(x: bounds.minX + CGFloat(offset) * (cell + gap), y: y),
          anchor: .topLeading, proposal: .init(width: cell, height: rowHeight))
      }
      y += rowHeight + gap
    }
  }
}
