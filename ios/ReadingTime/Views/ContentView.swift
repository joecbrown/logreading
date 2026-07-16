// Views/ContentView.swift

import SwiftUI

struct ContentView: View {
    @StateObject private var childStore = ChildStore()
    @State private var showingAddChild = false
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(childStore.children) { child in
                    NavigationLink(value: child) {
                        VStack(alignment: .leading) {
                            Text(child.displayName).font(.headline)
                            if let grade = child.grade {
                                Text(grade).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .onDelete { indexSet in
                    for index in indexSet {
                        childStore.remove(childStore.children[index])
                    }
                }
            }
            .navigationTitle("Reading Time")
            .navigationDestination(for: Child.self) { child in
                ReadingSessionView(viewModel: ReadingSessionViewModel(child: child))
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showingAddChild = true
                    } label: {
                        Label("Add Reader", systemImage: "plus")
                    }
                }
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        showingSettings = true
                    } label: {
                        Label("Settings", systemImage: "gear")
                    }
                }
            }
            .sheet(isPresented: $showingAddChild) {
                AddChildView(childStore: childStore)
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
            }
            .overlay {
                if childStore.children.isEmpty {
                    ContentUnavailableView(
                        "No readers yet",
                        systemImage: "book",
                        description: Text("Tap + to add your first reader.")
                    )
                }
            }
        }
    }
}

#Preview {
    ContentView()
}
