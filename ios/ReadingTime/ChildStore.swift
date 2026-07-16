// ChildStore.swift
//
// Local storage for child profiles. There's no backend endpoint for
// "which kids exist" — the REST API only knows about a childId once you
// log a session for it — so profiles (name, grade) live on-device via
// UserDefaults. Fine for a single family's iPad; would need to move
// server-side if this ever needs to sync across devices.

import Foundation
import Combine

@MainActor
final class ChildStore: ObservableObject {
    @Published private(set) var children: [Child] = []

    private let storageKey = "reading_time.children"

    init() {
        load()
    }

    func add(name: String, grade: String?) {
        let child = Child(id: Child.makeId(from: name), displayName: name, grade: grade)
        guard !children.contains(where: { $0.id == child.id }) else { return }
        children.append(child)
        save()
    }

    func remove(_ child: Child) {
        children.removeAll { $0.id == child.id }
        save()
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: storageKey) else { return }
        children = (try? JSONDecoder().decode([Child].self, from: data)) ?? []
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(children) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }
}
