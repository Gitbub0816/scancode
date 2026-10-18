import Foundation
import CoreGraphics

public enum PolarCodeError: Error {
    case emptyPayload, payloadTooLong, invalidBits, errorCorrection, invalidPayload, invalidImage
}

public struct PolarSlot {
    public let x: Double
    public let y: Double
    public let ring: Bool
}

private struct Random32 {
    private var state: UInt32
    init(_ seed: UInt32) { state = seed }
    mutating func next() -> UInt32 {
        state ^= state << 13
        state ^= state >> 17
        state ^= state << 5
        return state
    }
    mutating func unit() -> Double { Double(next()) / 4294967296.0 }
}

private struct GF256 {
    let exp: [Int]
    let log: [Int]
    init() {
        var e = [Int](repeating: 0, count: 512)
        var l = [Int](repeating: 0, count: 256)
        var x = 1
        for i in 0..<255 {
            e[i] = x; l[x] = i
            x <<= 1
            if x & 0x100 != 0 { x ^= 0x11d }
        }
        for i in 255..<512 { e[i] = e[i - 255] }
        exp = e; log = l
    }
    func multiply(_ a: Int, _ b: Int) -> Int { a == 0 || b == 0 ? 0 : exp[log[a] + log[b]] }
    func divide(_ a: Int, _ b: Int) -> Int { a == 0 ? 0 : exp[(log[a] - log[b] + 255) % 255] }
    func power(_ n: Int) -> Int { exp[(n % 255 + 255) % 255] }
}

private struct MarkerDot { let x: Double; let y: Double; let area: Int }
private struct Waypoint { let x: Double; let y: Double; let score: Double; let spacing: Double; let dots: [MarkerDot] }

public enum AsterHaloPolar {
    public static let payloadLimit = 87
    public static let bitCount = 1024
    public static let slots: [PolarSlot] = makeSlots()
    private static let gf = GF256()

    private static func makeSlots() -> [PolarSlot] {
        var inner: [PolarSlot] = [], cells: [String: [PolarSlot]] = [:]
        var placement = Random32(0x716ca2b5)
        while inner.count < bitCount - 256 {
            let angle = placement.unit() * 2 * Double.pi
            let radial = placement.unit()
            let radius = sqrt(0.14 * 0.14 + radial * (0.305 * 0.305 - 0.14 * 0.14))
            let x = 0.5 + radius * cos(angle), y = 0.5 + radius * sin(angle)
            let gx = Int(floor(x / 0.007)), gy = Int(floor(y / 0.007))
            var near = false
            for dx in -1...1 { for dy in -1...1 {
                for slot in cells["\(gx + dx),\(gy + dy)"] ?? [] {
                    if hypot(x - slot.x, y - slot.y) < 0.0065 { near = true; break }
                }
            }}
            if near { continue }
            let slot = PolarSlot(x: x, y: y, ring: false)
            inner.append(slot)
            let key = "\(gx),\(gy)"
            cells[key, default: []].append(slot)
        }
        let gap = 0.06, m1 = 5 * Double.pi / 4, m2 = 7 * Double.pi / 4
        let ranges = [(0.0, m1 - gap), (m1 + gap, m2 - gap), (m2 + gap, 2 * Double.pi)]
        let total = ranges.reduce(0.0) { $0 + $1.1 - $1.0 }
        var outer: [PolarSlot] = []
        for i in 0..<256 {
            var t = (Double(i) + 0.5) * total / 256
            var angle = 0.0
            for (a, b) in ranges {
                if t < b - a { angle = a + t; break }
                t -= b - a
            }
            outer.append(PolarSlot(x: 0.5 + 0.42 * cos(angle), y: 0.5 + 0.42 * sin(angle), ring: true))
        }
        var all = inner + outer
        var random = Random32(0xa57e2c91)
        for i in stride(from: all.count - 1, through: 1, by: -1) {
            let j = Int(random.next() % UInt32(i + 1))
            all.swapAt(i, j)
        }
        precondition(all.count == bitCount)
        return all
    }

    private static func crc32(_ bytes: [UInt8]) -> UInt32 {
        var crc: UInt32 = 0xffffffff
        for byte in bytes {
            crc ^= UInt32(byte)
            for _ in 0..<8 { crc = (crc >> 1) ^ ((crc & 1) == 1 ? 0xedb88320 : 0) }
        }
        return crc ^ 0xffffffff
    }

    private static func parity(_ data: [Int]) -> [Int] {
        var generator = [1]
        for i in 0..<32 {
            var next = [Int](repeating: 0, count: generator.count + 1)
            for j in generator.indices {
                next[j] ^= generator[j]
                next[j + 1] ^= gf.multiply(generator[j], gf.power(i))
            }
            generator = next
        }
        var working = data + [Int](repeating: 0, count: 32)
        for i in 0..<96 {
            let coefficient = working[i]
            if coefficient == 0 { continue }
            for j in generator.indices { working[i + j] ^= gf.multiply(coefficient, generator[j]) }
        }
        return data + Array(working[96..<128])
    }

    public static func encodeBits(_ payload: String) throws -> [UInt8] {
        guard !payload.isEmpty else { throw PolarCodeError.emptyPayload }
        let utf8 = Array(payload.utf8)
        guard utf8.count <= payloadLimit else { throw PolarCodeError.payloadTooLong }
        let crc = crc32(utf8)
        var data = [Int](repeating: 0, count: 96)
        data[0] = 0x50; data[1] = 0x43; data[2] = 3
        data[3] = utf8.count >> 8; data[4] = utf8.count & 255
        data[5] = Int((crc >> 24) & 255); data[6] = Int((crc >> 16) & 255)
        data[7] = Int((crc >> 8) & 255); data[8] = Int(crc & 255)
        for i in utf8.indices { data[9 + i] = Int(utf8[i]) }
        var pad = Random32(0x759e2361)
        for i in (9 + utf8.count)..<96 { data[i] = Int(pad.next() & 255) }
        let code = parity(data)
        var mask = Random32(0x2d943fa7)
        return (0..<bitCount).map { i in
            UInt8(((code[i >> 3] >> (7 - (i & 7))) & 1) ^ Int(mask.next() & 1))
        }
    }

    private static func correct(_ received: inout [Int]) throws {
        let syndromes = (0..<32).map { n -> Int in
            let alpha = gf.power(n)
            return received.reduce(0) { gf.multiply($0, alpha) ^ $1 }
        }
        if syndromes.allSatisfy({ $0 == 0 }) { return }
        var locator = [Int](repeating: 0, count: 33)
        var backup = [Int](repeating: 0, count: 33)
        locator[0] = 1; backup[0] = 1
        var length = 0, shift = 1, previous = 1
        for n in 0..<32 {
            var discrepancy = syndromes[n]
            if length > 0 { for i in 1...length { discrepancy ^= gf.multiply(locator[i], syndromes[n - i]) } }
            if discrepancy == 0 { shift += 1; continue }
            let old = locator
            let ratio = gf.divide(discrepancy, previous)
            if shift < locator.count {
                for i in 0..<(locator.count - shift) { locator[i + shift] ^= gf.multiply(ratio, backup[i]) }
            }
            if 2 * length <= n {
                length = n + 1 - length
                backup = old
                previous = discrepancy
                shift = 1
            } else { shift += 1 }
        }
        guard length > 0 && length <= 16 else { throw PolarCodeError.errorCorrection }
        var positions: [Int] = [], powers: [Int] = []
        for p in 0..<128 {
            let power = gf.power(127 - p)
            let inverse = gf.power(-(127 - p))
            var value = 0
            for i in stride(from: length, through: 0, by: -1) { value = gf.multiply(value, inverse) ^ locator[i] }
            if value == 0 { positions.append(p); powers.append(power) }
        }
        guard positions.count == length else { throw PolarCodeError.errorCorrection }
        // Vandermonde solve for magnitudes from the first L syndromes.
        var matrix = [[Int]](repeating: [Int](repeating: 0, count: length + 1), count: length)
        for row in 0..<length {
            for col in 0..<length { matrix[row][col] = row == 0 ? 1 : gf.power(gf.log[powers[col]] * row) }
            matrix[row][length] = syndromes[row]
        }
        for col in 0..<length {
            guard let pivot = (col..<length).first(where: { matrix[$0][col] != 0 }) else { throw PolarCodeError.errorCorrection }
            matrix.swapAt(col, pivot)
            let divisor = matrix[col][col]
            for c in col...length { matrix[col][c] = gf.divide(matrix[col][c], divisor) }
            for row in 0..<length where row != col {
                let factor = matrix[row][col]
                for c in col...length { matrix[row][c] ^= gf.multiply(factor, matrix[col][c]) }
            }
        }
        for i in 0..<length { received[positions[i]] ^= matrix[i][length] }
        for n in 0..<32 {
            let alpha = gf.power(n)
            let syndrome = received.reduce(0) { gf.multiply($0, alpha) ^ $1 }
            if syndrome != 0 { throw PolarCodeError.errorCorrection }
        }
    }

    public static func decodeBits(_ bits: [UInt8]) throws -> String {
        guard bits.count == bitCount, bits.allSatisfy({ $0 <= 1 }) else { throw PolarCodeError.invalidBits }
        var data = [Int](repeating: 0, count: 128)
        var mask = Random32(0x2d943fa7)
        for i in bits.indices { data[i >> 3] |= (Int(bits[i]) ^ Int(mask.next() & 1)) << (7 - (i & 7)) }
        try correct(&data)
        guard data[0] == 0x50 && data[1] == 0x43 && data[2] == 3 else { throw PolarCodeError.invalidPayload }
        let length = (data[3] << 8) | data[4]
        guard length > 0 && length <= payloadLimit else { throw PolarCodeError.invalidPayload }
        let utf8 = data[9..<(9 + length)].map(UInt8.init)
        let expected = UInt32(data[5]) << 24 | UInt32(data[6]) << 16 | UInt32(data[7]) << 8 | UInt32(data[8])
        guard crc32(utf8) == expected, let value = String(bytes: utf8, encoding: .utf8) else { throw PolarCodeError.invalidPayload }
        return value
    }

    private static func rgba(_ image: CGImage) throws -> [UInt8] {
        let width = image.width, height = image.height
        guard width >= 200 && height >= 200 else { throw PolarCodeError.invalidImage }
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let result = bytes.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard result else { throw PolarCodeError.invalidImage }
        return bytes
    }

    private static func luminance(_ bytes: [UInt8], _ width: Int, _ x: Int, _ y: Int) -> Int {
        let p = (y * width + x) * 4
        return (Int(bytes[p]) * 54 + Int(bytes[p + 1]) * 183 + Int(bytes[p + 2]) * 19) >> 8
    }

    private static func markerDots(_ bytes: [UInt8], _ width: Int, _ height: Int, threshold: Int) -> [MarkerDot] {
        var light = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height { for x in 0..<width {
            let p = (y * width + x) * 4
            let r = Int(bytes[p]), g = Int(bytes[p + 1]), b = Int(bytes[p + 2])
            light[y * width + x] = r > threshold && g > threshold && b > threshold && max(r,g,b) - min(r,g,b) < 68 ? 1 : 0
        }}
        var seen = [UInt8](repeating: 0, count: light.count)
        var queue = [Int](repeating: 0, count: light.count)
        var dots: [MarkerDot] = []
        for start in light.indices {
            if light[start] == 0 || seen[start] != 0 { continue }
            var head = 0, tail = 1, area = 0, sumX = 0, sumY = 0
            var minX = width, maxX = 0, minY = height, maxY = 0
            queue[0] = start; seen[start] = 1
            while head < tail {
                let p = queue[head]; head += 1
                let x = p % width, y = p / width
                area += 1; sumX += x; sumY += y
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
                for oy in -1...1 { for ox in -1...1 {
                    if ox == 0 && oy == 0 { continue }
                    let nx = x + ox, ny = y + oy
                    if nx < 0 || ny < 0 || nx >= width || ny >= height { continue }
                    let n = ny * width + nx
                    if light[n] != 0 && seen[n] == 0 { seen[n] = 1; queue[tail] = n; tail += 1 }
                }}
            }
            let bw = maxX - minX + 1, bh = maxY - minY + 1
            let ratio = Double(bw) / Double(bh)
            if area < 3 || area > 130 || bw < 2 || bh < 2 || bw > 18 || bh > 18 || ratio < 0.55 || ratio > 1.8 { continue }
            dots.append(MarkerDot(x: Double(sumX) / Double(area), y: Double(sumY) / Double(area), area: area))
        }
        return Array(dots.sorted(by: { $0.area > $1.area }).prefix(192))
    }

    private static func waypointCandidates(_ dots: [MarkerDot]) -> [Waypoint] {
        var found: [Waypoint] = []
        for middle in dots {
            let near = dots.filter { dot in
                let d = hypot(dot.x - middle.x, dot.y - middle.y)
                return d >= 3 && d <= 23 && Double(max(dot.area, middle.area)) / Double(min(dot.area, middle.area)) < 2.6
            }
            if near.count < 2 { continue }
            for i in 0..<(near.count - 1) { for j in (i + 1)..<near.count {
                let a = near[i], b = near[j]
                let ax = a.x - middle.x, ay = a.y - middle.y
                let bx = b.x - middle.x, by = b.y - middle.y
                let da = hypot(ax, ay), db = hypot(bx, by)
                if abs(da - db) / max(da, db) > 0.32 { continue }
                if (ax * bx + ay * by) / (da * db) > -0.86 { continue }
                let offset = hypot((a.x + b.x) / 2 - middle.x, (a.y + b.y) / 2 - middle.y)
                if offset > max(2.6, 0.24 * max(da, db)) { continue }
                let x = (a.x + middle.x + b.x) / 3, y = (a.y + middle.y + b.y) / 3
                if found.contains(where: { hypot($0.x - x, $0.y - y) < 5 }) { continue }
                found.append(Waypoint(x: x, y: y, score: Double(a.area + middle.area + b.area) - offset * 2, spacing: (da + db) / 2, dots: [a, middle, b]))
            }}
        }
        return Array(found.sorted(by: { $0.score > $1.score }).prefix(16))
    }

    private static func project(_ p: [Double], _ u: Double, _ v: Double) -> (Double, Double) {
        let c = cos(p[4]), s = sin(p[4]), den = 1 + p[5] * v
        return (p[0] + (p[2] * u * c - p[3] * v * s) / den,
                p[1] + (p[2] * u * s + p[3] * v * c) / den)
    }

    private static func inverse(_ p: [Double], _ x: Double, _ y: Double) -> (Double, Double) {
        let c = cos(p[4]), s = sin(p[4]), dx = x - p[0], dy = y - p[1]
        let uu = c * dx + s * dy, vv = -s * dx + c * dy
        let v = vv / (p[3] - p[5] * vv)
        return (uu * (1 + p[5] * v) / p[2], v)
    }

    private static func fitLoss(_ p: [Double], _ observed: [MarkerDot], _ source: [(Double, Double)], _ ring: [MarkerDot]) -> Double {
        if p[2] < 100 || p[3] < 100 || abs(p[5]) > 1.5 { return 1e15 }
        var sum = 0.0
        for i in 0..<6 {
            let (x, y) = project(p, source[i].0, source[i].1)
            sum += 0.5 * (pow(x - observed[i].x, 2) + pow(y - observed[i].y, 2))
        }
        for dot in ring {
            let (u, v) = inverse(p, dot.x, dot.y)
            let error = (hypot(u, v) - 0.42) * 1000
            sum += min(error * error, 4000)
        }
        return sum
    }

    private static func fitProjection(_ left: Waypoint, _ right: Waypoint, _ dots: [MarkerDot]) -> [Double] {
        let chord = hypot(right.x - left.x, right.y - left.y)
        let angle = atan2(right.y - left.y, right.x - left.x)
        let size = chord / (0.42 * sqrt(2.0))
        let midX = (left.x + right.x) / 2, midY = (left.y + right.y) / 2
        let initial = [midX - 0.297 * size * sin(angle), midY + 0.297 * size * cos(angle), size, size, angle, 0]
        let axisX = (right.x - left.x) / chord, axisY = (right.y - left.y) / chord
        let along: (MarkerDot, MarkerDot) -> Bool = { a, b in a.x * axisX + a.y * axisY < b.x * axisX + b.y * axisY }
        let observed = left.dots.sorted(by: along) + right.dots.sorted(by: along)
        var source: [(Double, Double)] = []
        for base in [5 * Double.pi / 4, 7 * Double.pi / 4] {
            for offset in [-0.029, 0, 0.029] { source.append((0.42 * cos(base + offset), 0.42 * sin(base + offset))) }
        }
        let ring = dots.filter { dot in
            let (u, v) = inverse(initial, dot.x, dot.y)
            let radius = hypot(u, v)
            return radius > 0.34 && radius < 0.52 && Double(dot.area) < max(50, left.score / 2)
        }
        var simplex = [initial]
        let step = [4.0, 4.0, 8.0, 8.0, 0.007, 0.04]
        for i in 0..<6 { var trial = initial; trial[i] += step[i]; simplex.append(trial) }
        var values = simplex.map { fitLoss($0, observed, source, ring) }
        for _ in 0..<450 {
            let order = (0..<7).sorted { values[$0] < values[$1] }
            simplex = order.map { simplex[$0] }; values = order.map { values[$0] }
            var center = [Double](repeating: 0, count: 6)
            for i in 0..<6 { for j in 0..<6 { center[j] += simplex[i][j] / 6 } }
            func trial(_ factor: Double) -> [Double] { (0..<6).map { center[$0] + factor * (center[$0] - simplex[6][$0]) } }
            let reflected = trial(1), reflectedLoss = fitLoss(reflected, observed, source, ring)
            if reflectedLoss < values[0] {
                let expanded = trial(2), expandedLoss = fitLoss(expanded, observed, source, ring)
                simplex[6] = expandedLoss < reflectedLoss ? expanded : reflected
                values[6] = min(expandedLoss, reflectedLoss)
            } else if reflectedLoss < values[5] {
                simplex[6] = reflected; values[6] = reflectedLoss
            } else {
                let contracted = trial(reflectedLoss < values[6] ? 0.5 : -0.5)
                let contractedLoss = fitLoss(contracted, observed, source, ring)
                if contractedLoss < min(reflectedLoss, values[6]) {
                    simplex[6] = contracted; values[6] = contractedLoss
                } else {
                    for i in 1..<7 {
                        simplex[i] = (0..<6).map { (simplex[0][$0] + simplex[i][$0]) / 2 }
                        values[i] = fitLoss(simplex[i], observed, source, ring)
                    }
                }
            }
        }
        let best = (0..<7).min { values[$0] < values[$1] } ?? 0
        return simplex[best]
    }

    private static func sampleProjection(_ bytes: [UInt8], _ width: Int, _ height: Int, _ p: [Double]) throws -> String {
        var bits = [UInt8](repeating: 0, count: bitCount)
        for i in 0..<bitCount {
            let slot = slots[i]
            let (x, y) = project(p, slot.x - 0.5, slot.y - 0.5)
            let xx = Int(x.rounded()), yy = Int(y.rounded())
            guard xx >= 0 && yy >= 0 && xx < width && yy < height else { throw PolarCodeError.invalidImage }
            bits[i] = luminance(bytes, width, xx, yy) > 105 ? 1 : 0
        }
        return try decodeBits(bits)
    }

    private static func sample(_ bytes: [UInt8], _ width: Int, _ height: Int,
                               _ a: Waypoint, _ b: Waypoint, _ q: Double,
                               _ offsetX: Double, _ offsetY: Double) throws -> String {
        let dx = b.x - a.x, dy = b.y - a.y, chord = hypot(dx, dy)
        let cosine = dx / chord, sine = dy / chord
        let sizeX = chord / (0.42 * sqrt(2.0)), sizeY = sizeX * q
        let cx = (a.x + b.x) / 2 - sine * chord * q / 2 + offsetX
        let cy = (a.y + b.y) / 2 + cosine * chord * q / 2 + offsetY
        var bits = [UInt8](repeating: 0, count: bitCount)
        for i in 0..<bitCount {
            let slot = slots[i]
            let xx = (slot.x - 0.5) * sizeX, yy = (slot.y - 0.5) * sizeY
            let x = Int((cx + xx * cosine - yy * sine).rounded())
            let y = Int((cy + xx * sine + yy * cosine).rounded())
            guard x >= 0 && y >= 0 && x < width && y < height else { throw PolarCodeError.invalidImage }
            bits[i] = luminance(bytes, width, x, y) > 95 ? 1 : 0
        }
        return try decodeBits(bits)
    }

    /** Full-frame scanner using the two three-dot waypoints. */
    public static func decode(_ image: CGImage) -> String? {
        guard let bytes = try? rgba(image) else { return nil }
        let width = image.width, height = image.height
        let ratios: [Double] = [1, 0.66, 0.662, 0.75, 0.8, 0.9, 1.1] + (0...60).map { 0.6 + Double($0) * 0.01 }
        let offsets: [(Double, Double)] = [(0,0),(0,0.5),(0,-0.5),(-0.5,0),(0.5,0),(-0.5,-0.5),(0.5,0.5),(-0.5,0.5),(0.5,-0.5)]
        for threshold in [185, 170] {
        let dots = markerDots(bytes, width, height, threshold: threshold)
        let waypoints = waypointCandidates(Array(dots.prefix(96)))
        if waypoints.count < 2 { continue }
        var pairs: [(Waypoint, Waypoint)] = []
        for i in 0..<(waypoints.count - 1) { for j in (i + 1)..<waypoints.count {
            let a = waypoints[i], b = waypoints[j], chord = hypot(a.x - b.x, a.y - b.y)
            let ratio = chord / ((a.spacing + b.spacing) / 2)
            if chord >= 90 && chord <= Double(max(width, height)) * 0.9 && ratio >= 32 && ratio <= 78 {
                pairs.append((a, b))
            }
        }}
        pairs.sort { $0.0.score + $0.1.score > $1.0.score + $1.1.score }
        for pair in pairs.prefix(3) {
            for (left, right) in [(pair.0, pair.1), (pair.1, pair.0)] {
                let fitted = fitProjection(left, right, dots)
                for step in 0...6 { for sign in [1.0, -1.0] { for axis in 0...1 {
                    let dx = axis == 0 ? sign * Double(step) * 0.5 : 0
                    let dy = axis == 1 ? sign * Double(step) * 0.5 : 0
                    for extra in [0.0, 0.5, -0.5, 1, -1] {
                        var adjusted = fitted; adjusted[0] += dx; adjusted[1] += dy + extra
                        if let value = try? sampleProjection(bytes, width, height, adjusted) { return value }
                    }
                }}}
            }
        }
        for i in 0..<(waypoints.count - 1) { for j in (i + 1)..<waypoints.count {
            let a = waypoints[i], b = waypoints[j], chord = hypot(a.x - b.x, a.y - b.y)
            if chord < 90 || chord > Double(max(width, height)) * 0.9 { continue }
            let spacingRatio = chord / ((a.spacing + b.spacing) / 2)
            if spacingRatio < 32 || spacingRatio > 78 { continue }
            for (left, right) in [(a,b),(b,a)] { for q in ratios { for (ox, oy) in offsets {
                if let value = try? sample(bytes, width, height, left, right, q, ox, oy) { return value }
            }}}
        }}
        }
        return nil
    }

    /** Render the one-row ring and encoded particle cloud. */
    public static func render(_ payload: String, size: Int = 800) throws -> CGImage {
        guard size >= 600 && size <= 4096 else { throw PolarCodeError.invalidImage }
        let bits = try encodeBits(payload)
        guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { throw PolarCodeError.invalidImage }
        let s = Double(size)
        context.translateBy(x: 0, y: CGFloat(size)); context.scaleBy(x: 1, y: -1)
        func color(_ r: Int, _ g: Int, _ b: Int) -> CGColor {
            CGColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
        }
        func circle(_ x: Double, _ y: Double, _ radius: Double, _ fill: CGColor) {
            context.setFillColor(fill)
            context.fillEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
        }
        func ridge(_ a: Double) -> Double {
            0.226 + 0.013 * sin(5 * a + 0.75) + 0.009 * cos(8 * a - 0.8) + 0.005 * sin(14 * a + 0.35)
        }
        context.setFillColor(color(4, 12, 22)); context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        circle(s / 2, s / 2, s * 0.475, color(16, 35, 56))
        let palette = [color(69,216,242), color(240,81,176), color(240,200,108), color(98,174,232)]
        var random = Random32(0x6f0b91e2)
        for i in 0..<30000 {
            let a = random.unit() * 2 * Double.pi
            let v = random.unit() * 2 * Double.pi
            let volume = 0.062 + 0.014 * sin(4 * a - 0.6) + 0.008 * cos(7 * a + 1.1)
            let cross = sqrt(random.unit()) * volume
            let fold = 0.008 * sin(12 * a + 2.2 * v) + 0.003 * cos(22 * a - 3 * v)
            let r = ridge(a) + cross * cos(v) + fold
            let depth = cross * sin(v), angle = a + 0.011 * sin(7 * a + v)
            let x = s * (0.5 + r * cos(angle)), y = s * (0.5 + r * sin(angle) + depth * 0.48)
            let chroma = sin(2.8 * a + 2.2 * sin(v) + 7 * (r - ridge(a)))
            let band = chroma > 0.38 ? 1 : chroma < -0.38 ? 0 : cos(4.8 * a + v) > 0 ? 3 : 2
            let depthLight = 0.43 + 0.57 * (0.5 + 0.5 * cos(v - 0.65))
            let light = (0.42 + 0.58 * max(0, sin(6 * a + v + r * 29))) * depthLight
            let opacity = i % 137 == 0 ? 0.94 : 0.29 + light * 0.52
            let dot = i % 137 == 0 ? 1.4 : i % 19 == 0 ? 0.94 : 0.5
            context.setAlpha(opacity)
            circle(x, y, dot * s / 800, palette[band])
        }
        context.setAlpha(1)
        let dataColors = [color(181,243,244), color(246,182,222), color(255,227,170), color(166,205,235)]
        for (i, slot) in slots.enumerated() {
            let x = slot.x * s, y = slot.y * s
            if bits[i] == 1 {
                let angle = atan2(slot.y - 0.5, slot.x - 0.5)
                let band = min(3, Int(floor((sin(angle * 2.9 + Double(i) * 0.37) + 1) * 1.999)))
                circle(x, y, (slot.ring ? 2.4 : 2.5) * s / 800, slot.ring ? color(195,233,233) : dataColors[band])
            } else {
                circle(x, y, (slot.ring ? 1.8 : 2.65) * s / 800, slot.ring ? color(38,56,70) : color(23,36,51))
            }
        }
        for base in [5 * Double.pi / 4, 7 * Double.pi / 4] { for offset in [-0.029, 0.0, 0.029] {
            let angle = base + offset
            circle(s * (0.5 + 0.42 * cos(angle)), s * (0.5 + 0.42 * sin(angle)), 3.65 * s / 800, color(214,248,245))
        }}
        context.setStrokeColor(color(112,214,226)); context.setAlpha(0.45)
        context.setLineWidth(1.5 * CGFloat(s) / 800)
        context.strokeEllipse(in: CGRect(x: s * 0.025, y: s * 0.025, width: s * 0.95, height: s * 0.95))
        context.setAlpha(1)
        context.setStrokeColor(color(233,252,255)); context.setLineWidth(6 * CGFloat(s) / 800)
        context.setLineCap(.round)
        context.move(to: CGPoint(x: s * 0.484, y: s * 0.466))
        context.addLine(to: CGPoint(x: s * 0.498, y: s * 0.508))
        context.addLine(to: CGPoint(x: s * 0.528, y: s * 0.494))
        context.strokePath()
        context.move(to: CGPoint(x: s * 0.498, y: s * 0.508))
        context.addLine(to: CGPoint(x: s * 0.476, y: s * 0.529))
        context.strokePath()
        guard let image = context.makeImage() else { throw PolarCodeError.invalidImage }
        return image
    }
}
