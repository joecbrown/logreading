// Views/ReadingSessionView.swift

import SwiftUI

struct ReadingSessionView: View {
    @StateObject var viewModel: ReadingSessionViewModel

    var body: some View {
        VStack(spacing: 24) {
            Text(viewModel.child.displayName)
                .font(.largeTitle.bold())

            statusBadge

            Text(timeString(from: viewModel.audio.activeSeconds))
                .font(.system(size: 56, weight: .semibold, design: .rounded))
                .monospacedDigit()

            if viewModel.audio.state != .idle {
                Text("Mic level: \(Int(viewModel.audio.currentDecibels)) dB  (pause threshold: \(Int(viewModel.audio.silenceThresholdDB)) dB)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }

            Button(action: toggle) {
                Text(viewModel.isRecording ? "Stop Reading" : "Start Reading")
                    .font(.title2.bold())
                    .frame(maxWidth: .infinity)
                    .padding()
            }
            .buttonStyle(.borderedProminent)
            .tint(viewModel.isRecording ? .red : .green)

            if let result = viewModel.lastResult {
                VStack(spacing: 4) {
                    Text("Last session: \(Int(result.minutesRead)) min")
                    Text("Earned \(formatHours(result.hoursEarned)) bonus hour\(result.hoursEarned == 1 ? "" : "s")")
                    if let wpm = result.wordsPerMinute {
                        Text("\(Int(wpm)) words/min")
                    }
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)

                if result.sessionId != nil && viewModel.questions == nil {
                    Button {
                        Task { await viewModel.checkForQuestions() }
                    } label: {
                        if viewModel.isCheckingForQuestions {
                            ProgressView()
                        } else {
                            Text("Check for Comprehension Questions")
                        }
                    }
                    .font(.footnote)
                    .disabled(viewModel.isCheckingForQuestions)
                }
            }

            if let questions = viewModel.questions {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Comprehension Questions")
                        .font(.headline)
                    ForEach(questions) { q in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(q.question).font(.subheadline.bold())
                            Text(q.guidance).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .background(Color.secondary.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }

            if let balance = viewModel.balance {
                VStack(spacing: 4) {
                    Text("This week: \(formatHours(balance.bonusHoursRemaining)) bonus hour\(balance.bonusHoursRemaining == 1 ? "" : "s") left")
                        .font(.headline)
                    Text("Available today: \(formatHours(balance.availableToday)) hour\(balance.availableToday == 1 ? "" : "s")")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.top)
            }

            if let error = viewModel.errorMessage {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }

            Spacer()
        }
        .padding()
        .task {
            await viewModel.refreshBalance()
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch viewModel.audio.state {
        case .idle:
            EmptyView()
        case .reading:
            Label("Reading", systemImage: "book.fill")
                .foregroundStyle(.green)
        case .paused:
            Label("Paused — no reading detected", systemImage: "pause.circle.fill")
                .foregroundStyle(.orange)
        }
    }

    private func toggle() {
        if viewModel.isRecording {
            Task { await viewModel.stopSession() }
        } else {
            Task { await viewModel.startSession() }
        }
    }

    private func timeString(from seconds: Int) -> String {
        let m = seconds / 60
        let s = seconds % 60
        return String(format: "%02d:%02d", m, s)
    }

    private func formatHours(_ hours: Double) -> String {
        hours.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(hours))
            : String(format: "%.1f", hours)
    }
}
