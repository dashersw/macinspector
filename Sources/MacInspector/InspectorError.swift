// SPDX-License-Identifier: MIT
import Foundation

public enum InspectorError: LocalizedError {
  case invalid(String)
  public var errorDescription: String? {
    if case .invalid(let message) = self { return message }
    return nil
  }
}
