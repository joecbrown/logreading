// Views/AddChildView.swift

import SwiftUI

struct AddChildView: View {
    @ObservedObject var childStore: ChildStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var grade = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Reader") {
                    TextField("Name", text: $name)
                    TextField("Grade (optional, e.g. \"6th grade\")", text: $grade)
                }
            }
            .navigationTitle("Add Reader")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        childStore.add(name: name, grade: grade.isEmpty ? nil : grade)
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
