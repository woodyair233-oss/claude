import Foundation

/// Side-by-side layout for overlapping blocks on a timeline column.
public enum TimelineLayout {
    public struct Item: Equatable, Sendable {
        public let id: String
        public let start: Double
        public let end: Double
        public init(id: String, start: Double, end: Double) {
            self.id = id
            self.start = start
            self.end = end
        }
    }

    public struct Slot: Equatable, Sendable {
        /// Zero-based column inside the overlap cluster.
        public let column: Int
        /// Columns in the cluster the item belongs to.
        public let columnCount: Int
        /// How many columns the item may stretch across (≥ 1) because the
        /// columns to its right are free for its whole duration.
        public let span: Int

        public init(column: Int, columnCount: Int, span: Int) {
            self.column = column
            self.columnCount = columnCount
            self.span = span
        }

        public var widthFraction: Double { Double(span) / Double(columnCount) }
        public var xFraction: Double { Double(column) / Double(columnCount) }
    }

    /// - Parameter minimumLength: very short items are treated as at least this
    ///   long, because that is how tall they are drawn; otherwise two 5-minute
    ///   items 10 minutes apart would be drawn on top of each other.
    public static func layout(_ items: [Item], minimumLength: Double = 20) -> [String: Slot] {
        let sorted = items.sorted {
            if $0.start != $1.start { return $0.start < $1.start }
            if $0.end != $1.end { return $0.end > $1.end }
            return $0.id < $1.id
        }
        func visualEnd(_ item: Item) -> Double { max(item.end, item.start + minimumLength) }

        var result: [String: Slot] = [:]
        var cluster: [(item: Item, column: Int)] = []
        var columnEnds: [Double] = []
        var clusterEnd = -Double.infinity

        func flush() {
            let count = columnEnds.count
            for (item, column) in cluster {
                var span = 1
                var next = column + 1
                while next < count {
                    let blocked = cluster.contains { other in
                        other.column == next
                            && other.item.start < visualEnd(item)
                            && visualEnd(other.item) > item.start
                    }
                    if blocked { break }
                    span += 1
                    next += 1
                }
                result[item.id] = Slot(column: column, columnCount: count, span: span)
            }
            cluster.removeAll()
            columnEnds.removeAll()
        }

        for item in sorted {
            if item.start >= clusterEnd, !cluster.isEmpty { flush() }
            let column: Int
            if let free = columnEnds.firstIndex(where: { $0 <= item.start }) {
                column = free
                columnEnds[free] = visualEnd(item)
            } else {
                column = columnEnds.count
                columnEnds.append(visualEnd(item))
            }
            cluster.append((item, column))
            clusterEnd = max(clusterEnd, visualEnd(item))
        }
        flush()
        return result
    }
}

/// How full a day is, for the month heat map.
public enum DayLoad {
    /// Total minutes covered by the union of the intervals, clipped to [lower, upper].
    public static func busyMinutes(_ intervals: [(start: Double, end: Double)],
                                   lower: Double = 0, upper: Double = 1440) -> Double {
        let clipped = intervals
            .map { (max($0.start, lower), min($0.end, upper)) }
            .filter { $0.1 > $0.0 }
            .sorted { $0.0 < $1.0 }
        var total = 0.0
        var current: (Double, Double)?
        for interval in clipped {
            if let c = current, interval.0 <= c.1 {
                current = (c.0, max(c.1, interval.1))
            } else {
                if let c = current { total += c.1 - c.0 }
                current = interval
            }
        }
        if let c = current { total += c.1 - c.0 }
        return total
    }

    /// 0 (empty) … 4 (full or over capacity).
    public static func level(busyMinutes: Double, capacityMinutes: Double) -> Int {
        guard busyMinutes > 0 else { return 0 }
        let ratio = busyMinutes / max(capacityMinutes, 1)
        switch ratio {
        case ..<0.25: return 1
        case ..<0.5: return 2
        case ..<0.85: return 3
        default: return 4
        }
    }
}

/// Free gaps between consecutive busy intervals, for the agenda list.
public enum FreeTime {
    public static func gaps(_ intervals: [(start: Double, end: Double)],
                            minimumGap: Double = 15) -> [(start: Double, end: Double)] {
        let sorted = intervals.sorted { $0.start < $1.start }
        var gaps: [(Double, Double)] = []
        var cursor: Double?
        for interval in sorted {
            if let c = cursor, interval.start - c >= minimumGap {
                gaps.append((c, interval.start))
            }
            cursor = max(cursor ?? interval.end, interval.end)
        }
        return gaps.map { (start: $0.0, end: $0.1) }
    }
}
