// SPDX-License-Identifier: MIT
import Foundation

extension NativeInspector {
  /// Reapply a file exported by the Native Changes panel after creating the UI.
  /// Identifiers are preferred; structural paths are checked against native classes.
  public func applyOverrides(_ data: Data) throws {
    precondition(Thread.isMainThread)
    guard data.count <= 1_048_576,
      let document = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      document["version"] as? Int == 1,
      let edits = document["edits"] as? [[String: Any]], edits.count <= 256
    else { throw InspectorError.invalid("Invalid MacInspector overrides file") }
    if let bundle = document["bundleId"] as? String, !bundle.isEmpty,
      bundle != Bundle.main.bundleIdentifier ?? ""
    {
      throw InspectorError.invalid("Overrides belong to a different app")
    }
    let tree = snapshot()
    let nodes = tree["nodes"] as! [[String: Any]]
    let indexed = Dictionary(uniqueKeysWithValues: nodes.map { ($0["id"] as! Int, $0) })
    let resolved = try edits.map { edit -> (Int, [String: Any]) in
      guard let target = edit["target"] as? [String: Any], let tag = target["tag"] as? String else {
        throw InspectorError.invalid("Missing override target")
      }
      let node: Int
      if let identifier = target["id"] as? String, !identifier.isEmpty {
        let matches = nodes.filter { ($0["attributes"] as? [String: String])?["id"] == identifier }
        guard matches.count == 1 else {
          throw InspectorError.invalid("Missing or ambiguous identifier: \(identifier)")
        }
        node = matches[0]["id"] as! Int
      } else if let path = target["path"] as? [Int], path.count <= 128 {
        var current = tree["root"] as! Int
        for index in path {
          guard let children = indexed[current]?["children"] as? [Int],
            children.indices.contains(index)
          else {
            throw InspectorError.invalid("Override path no longer exists")
          }
          current = children[index]
        }
        node = current
      } else {
        throw InspectorError.invalid("Invalid override locator")
      }
      guard indexed[node]?["tag"] as? String == tag else {
        throw InspectorError.invalid("Override target class changed")
      }
      return (node, edit)
    }
    var rollback: [() -> Void] = []
    do {
      for (node, edit) in resolved {
        if let styles = edit["styles"] as? [[String: Any]] {
          guard styles.count <= 128 else {
            throw InspectorError.invalid("Style override limit exceeded")
          }
          let operations = styles.filter { $0["disabled"] as? Bool != true }.map {
            value -> [String: Any] in
            ["key": value["name"] ?? "", "value": value["value"] ?? ""]
          }
          if let logical = try object(node) as? SwiftUIInspectionNode {
            rollback.append(try logical.checkpoint(operations))
            try logical.apply(operations)
          } else {
            let editor = try styleEditors[node] ?? NativeStyles(view(node))
            rollback.append(try editor.checkpoint(operations))
            try editor.apply(operations)
            styleEditors[node] = editor
          }
        }
        if let attributes = edit["attributes"] as? [String: String] {
          for (key, value) in attributes {
            let target = try object(node)
            let original = try attributeState(target, node: node, key: key)
            let restoreNode = original["node"] as! Int
            let restoreObject = try object(restoreNode)
            rollback.append {
              try? self.setAttribute(
                restoreObject, node: restoreNode, key: original["key"] as! String,
                value: original["value"] as! String)
            }
            try setAttribute(target, node: node, key: key, value: value)
          }
        }
        var layouts = edit["constraints"] as? [[String: Any]] ?? []
        if let priorities = edit["priorities"] as? [String: Any] { layouts.append(priorities) }
        guard layouts.count <= 256 else {
          throw InspectorError.invalid("Constraint override limit exceeded")
        }
        if !layouts.isEmpty, try object(node) is SwiftUIInspectionNode {
          throw InspectorError.invalid("SwiftUI overrides use registered layout bindings, not Auto Layout constraints")
        }
        for values in layouts {
          let target = try view(node)
          var params = values
          let before = try layout.inspect(target, id: { self.id($0) })
          let original: [String: Any]
          if let key = values["key"] as? String {
            let constraint = try layout.resolve(key, view: target)
            params["constraint"] = constraint
            let constraints = before["constraints"] as! [[String: Any]]
            var state = constraints.first { $0["id"] as? String == constraint }!
            state["constraint"] = constraint
            original = state
          } else {
            original = before
          }
          rollback.append { _ = try? self.layout.edit(target, params: original) }
          _ = try layout.edit(target, params: params)
        }
      }
    } catch {
      rollback.reversed().forEach { $0() }
      relayout()
      throw error
    }
  }

}
