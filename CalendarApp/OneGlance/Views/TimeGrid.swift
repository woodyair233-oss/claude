import SwiftUI
import GlanceCore

/// Hour grid with one column per day (1 for the day view, 7 for the week view).
///
/// - Long-press a block and drag to move it (across days in the week view).
/// - Long-press the bottom edge of a block and drag to change its length.
/// - Long-press empty space (and drag) or double-tap it to create an event.
/// - Drop a task chip on the grid to give it that time.
/// - Pinch to zoom the day view.
struct TimeGrid: View {
    @EnvironmentObject private var store: CalendarStore
    @EnvironmentObject private var prefs: Preferences
    @Environment(\.openEditor) private var openEditor
    let days: [Date]
    let compact: Bool

    @GestureState private var drag: BlockDrag? = nil
    @GestureState private var ghost: Ghost? = nil
    @State private var liveHourHeight: Double? = nil
    @State private var pinchStart: Double? = nil

    private let cal = Calendar.current
    private var gutter: CGFloat { compact ? 30 : 46 }
    private var hourHeight: CGFloat { compact ? 44 : CGFloat(liveHourHeight ?? prefs.hourHeight) }
    private var snapStep: Double { hourHeight >= 100 ? 5 : 15 }
    private var minBlockHeight: CGFloat { compact ? 16 : 22 }

    struct Block: Identifiable {
        enum Source { case event(EventItem), task(TaskItem) }
        let id: String
        let dayIndex: Int
        let source: Source
        /// Minutes on the column's clock, clipped to the day.
        let start: Double
        let end: Double
        let title: String
        let color: Color
        let canEdit: Bool
        let isTask: Bool
        let detail: String?
    }

    struct BlockDrag: Equatable {
        enum Mode { case move, resize }
        let id: String
        let mode: Mode
        var minutes: Double
        var days: Int
    }

    struct Placed: Identifiable {
        let block: Block
        let slot: TimelineLayout.Slot
        var id: String { block.id }
    }

    struct Ghost: Equatable {
        var dayIndex: Int
        var start: Int
        var end: Int
    }

    var body: some View {
        let blocks = makeBlocks()
        ScrollViewReader { proxy in
            ScrollView {
                ZStack(alignment: .topLeading) {
                    hourRows
                    GeometryReader { geo in
                        let columnWidth = max((geo.size.width - gutter) / CGFloat(max(days.count, 1)), 1)
                        ZStack(alignment: .topLeading) {
                            columnBackgrounds(columnWidth: columnWidth)
                            createSurface(columnWidth: columnWidth)
                            ForEach(placed(blocks)) { item in
                                blockView(item.block, slot: item.slot, columnWidth: columnWidth)
                            }
                            if let ghost { ghostView(ghost, columnWidth: columnWidth) }
                            nowLine(columnWidth: columnWidth)
                        }
                        .dropDestination(for: String.self) { items, location in
                            let index = min(max(Int((location.x - gutter) / columnWidth), 0), days.count - 1)
                            let minute = Int(Snap.minutes(Double(location.y / hourHeight) * 60, step: 15))
                            return DropHandler.schedule(items, store: store, day: days[index], minute: min(max(minute, 0), 1425))
                        }
                    }
                }
                .frame(height: hourHeight * 24)
            }
            .onAppear { scrollToFocus(proxy, blocks: blocks, animated: false) }
            .onChange(of: days.first) { scrollToFocus(proxy, blocks: makeBlocks(), animated: true) }
        }
        .simultaneousGesture(magnify, including: compact ? .subviews : .all)
        .sensoryFeedback(.impact(weight: .light), trigger: drag?.id)
        .sensoryFeedback(.impact(weight: .light), trigger: ghost != nil)
    }

    // MARK: - Data

    private func makeBlocks() -> [Block] {
        var result: [Block] = []
        for (index, day) in days.enumerated() {
            let agenda = store.agenda(for: day)
            for e in agenda.timed {
                let s = max(0, cal.minuteOfDay(e.start, relativeTo: day))
                let en = min(1440, cal.minuteOfDay(e.end, relativeTo: day))
                guard en > s || e.end == e.start else { continue }
                result.append(Block(id: "\(index)|e|\(e.id)", dayIndex: index, source: .event(e),
                                    start: s, end: max(en, s), title: e.title, color: e.color,
                                    canEdit: e.canEdit, isTask: false, detail: e.location))
            }
            for t in agenda.timedTasks {
                guard let due = t.due else { continue }
                let s = cal.minuteOfDay(due, relativeTo: day)
                result.append(Block(id: "\(index)|t|\(t.id)", dayIndex: index, source: .task(t),
                                    start: s, end: min(1440, s + Double(t.durationMinutes)), title: t.title,
                                    color: t.color, canEdit: true, isTask: true, detail: t.listTitle))
            }
        }
        return result
    }

    private func placed(_ blocks: [Block]) -> [Placed] {
        let minLength = Double(minBlockHeight / hourHeight) * 60
        var out: [Placed] = []
        for index in days.indices {
            let column = blocks.filter { $0.dayIndex == index }
            let slots = TimelineLayout.layout(column.map { .init(id: $0.id, start: $0.start, end: $0.end) },
                                              minimumLength: minLength)
            for b in column {
                out.append(Placed(block: b, slot: slots[b.id] ?? .init(column: 0, columnCount: 1, span: 1)))
            }
        }
        return out
    }

    // MARK: - Grid

    private var hourRows: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                ZStack(alignment: .topLeading) {
                    Rectangle()
                        .fill(Color(.separator).opacity(0.6))
                        .frame(height: 0.5)
                        .padding(.leading, gutter)
                    if hour > 0 {
                        Text(compact ? "\(hour)" : String(format: "%02d:00", hour))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(width: gutter - 6, alignment: .trailing)
                            .offset(y: -7)
                    }
                    if !compact && hourHeight >= 80 {
                        Rectangle()
                            .fill(Color(.separator).opacity(0.25))
                            .frame(height: 0.5)
                            .padding(.leading, gutter)
                            .offset(y: hourHeight / 2)
                    }
                }
                .frame(height: hourHeight, alignment: .top)
                .id(hour)
            }
        }
    }

    @ViewBuilder
    private func columnBackgrounds(columnWidth: CGFloat) -> some View {
        if days.count > 1 {
            ForEach(Array(days.enumerated()), id: \.offset) { index, day in
                Rectangle()
                    .fill(cal.isDateInToday(day) ? Color.accentColor.opacity(0.06) : Color.clear)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(Color(.separator).opacity(0.4)).frame(width: 0.5)
                    }
                    .frame(width: columnWidth, height: hourHeight * 24)
                    .offset(x: gutter + CGFloat(index) * columnWidth)
                    .allowsHitTesting(false)
            }
        }
    }

    private func createSurface(columnWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: gutter)
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture(count: 2, coordinateSpace: .local) { point in
                    let start = Int(Snap.minutes(Double(point.y / hourHeight) * 60 - 15, step: 15))
                    let g = Ghost(dayIndex: column(at: point.x, columnWidth),
                                  start: max(0, start), end: max(0, start) + prefs.defaultEventMinutes)
                    openNewEvent(g)
                }
                .gesture(createGesture(columnWidth: columnWidth))
        }
        .frame(height: hourHeight * 24)
    }

    private func column(at x: CGFloat, _ columnWidth: CGFloat) -> Int {
        min(max(Int(x / columnWidth), 0), days.count - 1)
    }

    private func minute(at y: CGFloat) -> Double { Double(y / hourHeight) * 60 }

    private func createGesture(columnWidth: CGFloat) -> some Gesture {
        LongPressGesture(minimumDuration: 0.35)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
            .updating($ghost) { value, state, _ in
                guard case .second(true, let d?) = value else { return }
                state = makeGhost(from: d.startLocation, to: d.location, columnWidth: columnWidth)
            }
            .onEnded { value in
                guard case .second(true, let d?) = value else { return }
                openNewEvent(makeGhost(from: d.startLocation, to: d.location, columnWidth: columnWidth))
            }
    }

    private func makeGhost(from a: CGPoint, to b: CGPoint, columnWidth: CGFloat) -> Ghost {
        let start = Int((minute(at: a.y) / 15).rounded(.down) * 15)
        let rawEnd = Int(Snap.minutes(minute(at: b.y), step: 15))
        let end = rawEnd - start >= 15 ? rawEnd : start + prefs.defaultEventMinutes
        return Ghost(dayIndex: column(at: a.x, columnWidth), start: max(0, start), end: min(1440, end))
    }

    private func openNewEvent(_ g: Ghost) {
        let day = days[g.dayIndex]
        var draft = CalendarStore.EventDraft()
        draft.start = cal.date(onDay: day, minute: g.start)
        draft.end = cal.date(onDay: day, minute: max(g.end, g.start + 15))
        draft.calendarID = store.defaultEventCalendar?.calendarIdentifier
        openEditor(.event(draft, nil))
    }

    private func ghostView(_ g: Ghost, columnWidth: CGFloat) -> some View {
        let y = CGFloat(g.start) / 60 * hourHeight
        let h = max(CGFloat(g.end - g.start) / 60 * hourHeight, minBlockHeight)
        return RoundedRectangle(cornerRadius: 6)
            .fill(Color.accentColor.opacity(0.25))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])))
            .overlay(alignment: .topLeading) {
                Text("\(clock(g.start))–\(clock(g.end))")
                    .font(.caption2.monospacedDigit().bold())
                    .padding(4)
            }
            .frame(width: columnWidth - 2, height: h)
            .offset(x: gutter + CGFloat(g.dayIndex) * columnWidth, y: y)
            .allowsHitTesting(false)
    }

    @ViewBuilder
    private func nowLine(columnWidth: CGFloat) -> some View {
        if let index = days.firstIndex(where: { cal.isDateInToday($0) }) {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                let y = CGFloat(cal.minuteOfDay(context.date, relativeTo: days[index]) / 60) * hourHeight
                HStack(spacing: 0) {
                    Circle().fill(.red).frame(width: 7, height: 7)
                    Rectangle().fill(.red).frame(height: 1.5)
                }
                .frame(width: columnWidth + 3.5)
                .offset(x: gutter + CGFloat(index) * columnWidth - 3.5, y: y - 3.5)
            }
            .allowsHitTesting(false)
        }
    }

    // MARK: - Blocks

    private func blockView(_ b: Block, slot: TimelineLayout.Slot, columnWidth: CGFloat) -> some View {
        let active = drag?.id == b.id ? drag : nil
        var s = b.start, e = b.end, dayShift = 0
        if let active {
            switch active.mode {
            case .move:
                s += active.minutes
                e += active.minutes
                dayShift = active.days
            case .resize:
                e = max(s + 15, e + active.minutes)
            }
        }
        let x = gutter + CGFloat(b.dayIndex + dayShift) * columnWidth + CGFloat(slot.xFraction) * columnWidth
        let w = max(CGFloat(slot.widthFraction) * columnWidth - 2, 8)
        let y = CGFloat(s / 60) * hourHeight
        let h = max(CGFloat((e - s) / 60) * hourHeight - 1, minBlockHeight)

        return BlockCard(block: b, height: h, compact: compact, isActive: active != nil,
                         timeText: "\(clock(Int(s)))–\(clock(Int(e)))")
            .frame(width: w, height: h)
            .overlay(alignment: .bottom) {
                if !compact && b.canEdit {
                    resizeHandle(b, visible: h >= 34)
                }
            }
            .offset(x: x, y: y)
            .zIndex(active != nil ? 10 : 1)
            .onTapGesture { open(b) }
            .gesture(moveGesture(b, columnWidth: columnWidth))
    }

    private func resizeHandle(_ b: Block, visible: Bool) -> some View {
        Capsule()
            .fill(b.color.opacity(visible ? 0.8 : 0))
            .frame(width: 22, height: 4)
            .frame(maxWidth: .infinity)
            .frame(height: 14, alignment: .bottom)
            .padding(.bottom, 2)
            .contentShape(Rectangle())
            .gesture(resizeGesture(b))
    }

    private func moveGesture(_ b: Block, columnWidth: CGFloat) -> some Gesture {
        LongPressGesture(minimumDuration: 0.3)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .global))
            .updating($drag) { value, state, _ in
                guard b.canEdit, case .second(true, let d) = value else { return }
                let t = d?.translation ?? .zero
                state = BlockDrag(id: b.id, mode: .move,
                                  minutes: moveDelta(b, dy: t.height),
                                  days: dayDelta(b, dx: t.width, columnWidth: columnWidth))
            }
            .onEnded { value in
                guard b.canEdit, case .second(true, let d?) = value else { return }
                commitMove(b, minutes: moveDelta(b, dy: d.translation.height),
                           days: dayDelta(b, dx: d.translation.width, columnWidth: columnWidth))
            }
    }

    private func resizeGesture(_ b: Block) -> some Gesture {
        LongPressGesture(minimumDuration: 0.2)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .global))
            .updating($drag) { value, state, _ in
                guard case .second(true, let d) = value else { return }
                state = BlockDrag(id: b.id, mode: .resize, minutes: resizeDelta(b, dy: d?.translation.height ?? 0), days: 0)
            }
            .onEnded { value in
                guard case .second(true, let d?) = value else { return }
                commitResize(b, minutes: resizeDelta(b, dy: d.translation.height))
            }
    }

    /// Moves so the new start lands on the snap grid.
    private func moveDelta(_ b: Block, dy: CGFloat) -> Double {
        let target = Double(Snap.minutes(b.start + minute(at: dy), step: Int(snapStep)))
        return min(max(target, 0), 1440 - snapStep) - b.start
    }

    private func resizeDelta(_ b: Block, dy: CGFloat) -> Double {
        let target = Double(Snap.minutes(b.end + minute(at: dy), step: Int(snapStep)))
        return max(target, b.start + 15) - b.end
    }

    private func dayDelta(_ b: Block, dx: CGFloat, columnWidth: CGFloat) -> Int {
        guard days.count > 1 else { return 0 }
        let raw = Int((dx / columnWidth).rounded())
        return min(max(raw, -b.dayIndex), days.count - 1 - b.dayIndex)
    }

    private func commitMove(_ b: Block, minutes: Double, days dayOffset: Int) {
        guard minutes != 0 || dayOffset != 0 else { return }
        func shifted(_ date: Date) -> Date {
            let moved = date.addingTimeInterval(minutes * 60)
            return dayOffset == 0 ? moved : (cal.date(byAdding: .day, value: dayOffset, to: moved) ?? moved)
        }
        switch b.source {
        case .event(let e):
            store.move(e, toStart: shifted(e.start))
        case .task(let t):
            if let due = t.due { store.schedule(t, at: shifted(due), hasTime: true) }
        }
    }

    private func commitResize(_ b: Block, minutes: Double) {
        guard minutes != 0 else { return }
        switch b.source {
        case .event(let e):
            store.resize(e, toEnd: e.end.addingTimeInterval(minutes * 60))
        case .task(let t):
            store.setDuration(t, minutes: t.durationMinutes + Int(minutes))
        }
    }

    private func open(_ b: Block) {
        switch b.source {
        case .event(let e): openEditor(.event(store.draft(for: e), e))
        case .task(let t): openEditor(.task(store.draft(for: t), t))
        }
    }

    // MARK: - Zoom and scrolling

    private var magnify: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                if pinchStart == nil { pinchStart = prefs.hourHeight }
                liveHourHeight = min(max((pinchStart ?? 56) * value.magnification, 28), 160)
            }
            .onEnded { _ in
                if let live = liveHourHeight { prefs.hourHeight = live }
                liveHourHeight = nil
                pinchStart = nil
            }
    }

    private func scrollToFocus(_ proxy: ScrollViewProxy, blocks: [Block], animated: Bool) {
        let hour: Int
        if days.contains(where: { cal.isDateInToday($0) }) {
            hour = cal.component(.hour, from: Date()) - 1
        } else if let first = blocks.map(\.start).min() {
            hour = Int(first / 60) - 1
        } else {
            hour = 8
        }
        let target = min(max(hour, 0), 23)
        DispatchQueue.main.async {
            if animated {
                withAnimation { proxy.scrollTo(target, anchor: .top) }
            } else {
                proxy.scrollTo(target, anchor: .top)
            }
        }
    }

    private func clock(_ minute: Int) -> String {
        let m = ((minute % 1440) + 1440) % 1440
        return String(format: "%02d:%02d", m / 60, m % 60)
    }
}

/// One event or task on the grid.
struct BlockCard: View {
    @EnvironmentObject private var store: CalendarStore
    let block: TimeGrid.Block
    let height: CGFloat
    let compact: Bool
    let isActive: Bool
    let timeText: String

    var body: some View {
        HStack(alignment: .top, spacing: 3) {
            if block.isTask, !compact, case .task(let task) = block.source {
                Button { store.toggle(task) } label: {
                    Image(systemName: "circle").font(.caption).foregroundStyle(block.color)
                }
                .buttonStyle(.plain)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(block.title)
                    .font(compact ? .system(size: 10, weight: .medium) : .caption.weight(.semibold))
                    .lineLimit(compact ? max(1, Int(height / 12)) : (height > 44 ? 2 : 1))
                if !compact && (height >= 34 || isActive) {
                    Text([timeText, block.detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, compact ? 3 : 6)
        .padding(.trailing, 2)
        .padding(.vertical, compact ? 1 : 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(block.color.opacity(block.isTask ? 0.10 : 0.22))
        .overlay(alignment: .leading) {
            Rectangle().fill(block.color).frame(width: block.isTask ? 0 : 3)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .strokeBorder(block.color.opacity(block.isTask ? 0.8 : 0),
                              style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
        }
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .overlay(alignment: .top) {
            if isActive {
                Text(timeText)
                    .font(.caption2.monospacedDigit().bold())
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(.regularMaterial, in: Capsule())
                    .offset(y: -18)
                    .fixedSize()
            }
        }
        .shadow(color: .black.opacity(isActive ? 0.25 : 0), radius: 6, y: 3)
        .scaleEffect(isActive ? 1.02 : 1)
        .animation(.snappy(duration: 0.15), value: isActive)
    }
}
