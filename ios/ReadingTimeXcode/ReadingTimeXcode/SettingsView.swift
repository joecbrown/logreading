// Views/SettingsView.swift

import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var urlText: String = APIClient.shared.baseURL?.absoluteString ?? ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://your-api-id.execute-api.us-east-1.amazonaws.com", text: $urlText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("API Base URL")
                } footer: {
                    Text("The invoke URL of the HTTP API from API Gateway, once api/handler.js is deployed. See the README's \"Deploying the REST API\" section.")
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        APIClient.shared.baseURL = URL(string: urlText)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
