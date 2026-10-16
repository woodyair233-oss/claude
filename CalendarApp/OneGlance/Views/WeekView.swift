import SwiftUI
import GlanceCore

/// Seven columns: day headers with shift badges, a row for all-day items and
/// task counts, and the shared time grid (drag events between days).
struct WeekView: View {
    @EnvironmentObject private var store: CalendarStore
    @Binding var selectedDay: Date
    @Binding var mode: ViewMode
    private let cal = Calendar.current
    private let gutter: CGFloat = 30

    var body: some View {
        let days = cal.weekDays(containing: selectedDay)
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Color.clear.frame(width: gutter)
                ForEach(days, id: \.self) { day in
                    header(day)
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            selectedDay = day
                            mode = .day
                        }
                        .dropDestination(for: String.self) { items, _ in
                            DropHandler.schedule(items, store: store, day: day, minute: nil)
                        }
                }
            }
            .padding(.vertical, 4)
            .gesture(weekSwipe)

            HStack(alignment: .top, spacing: 0) {
                Text("全天")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .frame(width: gutter)
                ForEach(days, id: \.self) { day in
                    allDayCell(store.agenda(for: day))
                        .frame(maxWidth: .infinity, alignment: .top)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            selectedDay = day
                            mode = .day
                        }
                }
            }
            .padding(.bottom, 4)
            Divider()
            TimeGrid(days: days, compact: true)
        }
    }

    private func header(_ day: Date) -> some View {
        let today = cal.isDateInToday(day)
        let selected = cal.isDate(day, inSameDayAs: selectedDay)
        return VStack(spacing: 2) {
            Text(Fmt.weekdayLetter(day)).font(.caption2).foregroundStyle(.secondary)
            Text("\(cal.component(.day, from: day))")
                .font(.subheadline.monospacedDigit().weight(today ? .bold : .regular))
                .foregroundStyle(today ? Color.white : (selected ? Color.accentColor : Color.primary))
                .frame(width: 26, height: 26)
                .background(Circle().fill(today ? Color.accentColor : Color.clear))
        }
    }

    private func allDayCell(_ agenda: DayAgenda) -> some View {
        VStack(spacing: 2) {
            if let shift = agenda.shifts.first?.shift {
                ShiftBadge(template: shift, size: 10)
            }
            ForEach(agenda.allDay.prefix(2)) { event in
                Text(event.title)
                    .font(.system(size: 9, weight: .medium))
                    .lineLimit(1)
                    .padding(.horizontal, 2)
                    .frame(maxWidth: .infinity)
                    .background(event.color.opacity(0.25), in: RoundedRectangle(cornerRadius: 3))
            }
            if agenda.allDay.count > 2 {
                Text("+\(agenda.allDay.count - 2)").font(.system(size: 9)).foregroundStyle(.secondary)
            }
            let pending = agenda.untimedTasks.count + agenda.overdue.count
            if pending > 0 {
                HStack(spacing: 1) {
                    Image(systemName: "checklist")
                    Text("\(pending)")
                }
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(agenda.overdue.isEmpty ? Color.secondary : Color.red)
            }
        }
        .padding(.horizontal, 1)
        .frame(minHeight: 18)
    }

    private var weekSwipe: some Gesture {
        DragGesture(minimumDistance: 30)
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let weeks = value.translation.width < 0 ? 1 : -1
                withAnimation(.snappy) {
                    selectedDay = cal.date(byAdding: .day, value: 7 * weeks, to: selectedDay) ?? selectedDay
                }
            }
    }
}
