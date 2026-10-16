import SwiftUI
import GlanceCore

/// Month grid coloured by how busy each day is, with shift badges, a shift
/// "brush" for fast rostering, and the selected day's items underneath.
struct MonthView: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    @Binding var selectedDay: Date
    @Binding var mode: ViewMode
    @State private var brushOn = false
    @State private var brush: Brush = .eraser

    enum Brush: Hashable {
        case template(UUID)
        case eraser
    }

    private let cal = Calendar.current
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 7)

    var body: some View {
        let grid = cal.monthGrid(for: selectedDay)
        VStack(spacing: 6) {
            HStack(spacing: 3) {
                ForEach(grid.prefix(7), id: \.self) { day in
                    Text(Fmt.weekdayLetter(day))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.top, 6)
            LazyVGrid(columns: columns, spacing: 3) {
                ForEach(grid, id: \.self) { day in
                    cell(day)
                        .onTapGesture { tap(day) }
                        .dropDestination(for: String.self) { items, _ in
                            DropHandler.schedule(items, store: store, day: day, minute: nil)
                        }
                }
            }
            .gesture(monthSwipe)
            summaryRow
            if brushOn { brushBar }
            Divider()
            DayDigest(day: selectedDay, mode: $mode)
        }
        .padding(.horizontal, 8)
    }

    private func tap(_ day: Date) {
        if brushOn {
            switch brush {
            case .template(let id):
                if let template = prefs.template(id: id) { store.applyShift(template, on: day) }
            case .eraser:
                store.clearShifts(on: day)
            }
        }
        withAnimation(.snappy(duration: 0.2)) { selectedDay = day }
    }

    private func cell(_ day: Date) -> some View {
        let inMonth = cal.isSameMonth(day, selectedDay)
        let today = cal.isDateInToday(day)
        let selected = cal.isDate(day, inSameDayAs: selectedDay)
        let agenda = store.agenda(for: day)
        let level = store.loadLevel(for: day)
        let shiftEvent = agenda.shifts.first
        let shortRest = shiftEvent.flatMap { store.shortRest(before: $0) } != nil
        let eventCount = agenda.timed.filter { $0.shift == nil }.count + agenda.allDay.count
        let taskCount = agenda.pendingTaskCount

        return VStack(spacing: 2) {
            Text("\(cal.component(.day, from: day))")
                .font(.callout.monospacedDigit().weight(today ? .bold : .regular))
                .foregroundStyle(today ? Color.accentColor : (level >= 4 ? Color.white : Color.primary))
            ZStack {
                if let template = shiftEvent?.shift {
                    ShiftBadge(template: template, size: 10)
                }
            }
            .frame(height: 14)
            HStack(spacing: 3) {
                if eventCount > 0 {
                    Text("\(eventCount)")
                        .font(.system(size: 9, weight: .semibold).monospacedDigit())
                        .foregroundStyle(level >= 4 ? Color.white : Color.secondary)
                }
                if taskCount > 0 {
                    HStack(spacing: 0) {
                        Image(systemName: "checkmark.circle")
                        Text("\(taskCount)")
                    }
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(agenda.overdue.isEmpty ? (level >= 4 ? Color.white : Color.secondary) : Color.red)
                }
            }
            .frame(height: 11)
        }
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(Color.heat(level), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(selected ? Color.accentColor : Color.clear, lineWidth: 2)
        }
        .overlay(alignment: .topTrailing) {
            if shortRest {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(.orange)
                    .padding(3)
            }
        }
        .opacity(inMonth ? 1 : 0.35)
        .contentShape(Rectangle())
    }

    private var summaryRow: some View {
        let comps = cal.dateComponents([.year, .month], from: selectedDay)
        let start = cal.date(from: comps) ?? selectedDay
        let end = cal.date(byAdding: .month, value: 1, to: start) ?? selectedDay
        let summary = ShiftAnalysis.summary(store.shiftOccurrences(in: DateInterval(start: start, end: end)),
                                            in: DateInterval(start: start, end: end))
        let counts = prefs.shiftTemplates.compactMap { t -> String? in
            guard let n = summary.countByTemplate[t.id], n > 0 else { return nil }
            return "\(t.name) \(n)"
        }
        return HStack(spacing: 8) {
            HStack(spacing: 2) {
                Text("空").font(.system(size: 9)).foregroundStyle(.secondary)
                ForEach(0..<5, id: \.self) { level in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(level == 0 ? Color(.secondarySystemBackground) : Color.heat(level))
                        .frame(width: 10, height: 10)
                }
                Text("满").font(.system(size: 9)).foregroundStyle(.secondary)
            }
            Text(counts.isEmpty ? "本月未排班" : counts.joined(separator: " · ") + " · 工时 \(summary.totalWorkMinutes / 60)h")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 0)
            Button {
                withAnimation(.snappy) { brushOn.toggle() }
                if brushOn, case .eraser = brush, let first = prefs.shiftTemplates.first { brush = .template(first.id) }
            } label: {
                Label("排班", systemImage: brushOn ? "paintbrush.fill" : "paintbrush")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(brushOn ? .accentColor : .secondary)
        }
    }

    private var brushBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("选好班次后点日期即可排班；再点一次同一班次可取消").font(.caption2).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(prefs.shiftTemplates) { t in
                        let on = brush == .template(t.id)
                        Button { brush = .template(t.id) } label: {
                            HStack(spacing: 4) {
                                ShiftBadge(template: t, size: 11)
                                Text(t.name).font(.subheadline)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(Color(hex: t.colorHex).opacity(on ? 0.25 : 0.08), in: Capsule())
                            .overlay(Capsule().strokeBorder(on ? Color(hex: t.colorHex) : Color.clear, lineWidth: 1.5))
                        }
                        .buttonStyle(.plain)
                    }
                    Button { brush = .eraser } label: {
                        Label("清除", systemImage: "eraser")
                            .font(.subheadline)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(Color.secondary.opacity(brush == .eraser ? 0.25 : 0.08), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(8)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }

    private var monthSwipe: some Gesture {
        DragGesture(minimumDistance: 30)
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let step = value.translation.width < 0 ? 1 : -1
                withAnimation(.snappy) {
                    selectedDay = cal.date(byAdding: .month, value: step, to: selectedDay) ?? selectedDay
                }
            }
    }
}

/// Compact read-out of one day under the month grid.
struct DayDigest: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    let day: Date
    @Binding var mode: ViewMode

    var body: some View {
        let agenda = store.agenda(for: day)
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(Fmt.relativeDay(day)).font(.subheadline.bold())
                    Spacer()
                    Button {
                        mode = .day
                    } label: {
                        Label("日视图", systemImage: "arrow.up.left.and.arrow.down.right")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
                if agenda.isEmpty {
                    Text("这天没有安排").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(agenda.shifts) { ShiftBanner(event: $0) }
                ForEach(agenda.timed.filter { $0.shift == nil }) { EventRow(event: $0, showTime: true) }
                ForEach(agenda.timedTasks) { TaskRow(task: $0) }
                FlowLayout(spacing: 6) {
                    ForEach(agenda.allDay) { EventChip(event: $0) }
                    ForEach(agenda.overdue) { TaskChip(task: $0, overdue: true) }
                    ForEach(agenda.untimedTasks) { TaskChip(task: $0) }
                    if prefs.showCompleted {
                        ForEach(agenda.completed) { TaskChip(task: $0) }
                    }
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 4)
        }
    }
}
