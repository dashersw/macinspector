// SPDX-License-Identifier: MIT
import MacInspector
import SwiftUI

@main
struct SwiftUIShowcaseApp: App {
  var body: some Scene {
    WindowGroup { ShowcaseView().macInspectorRoot() }
  }
}
