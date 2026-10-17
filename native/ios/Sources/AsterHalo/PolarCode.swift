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
private struct Waypoint { let x: Double; let y: Double; let score: Double }

public enum AsterHaloPolar {
    public static let payloadLimit = 214
    public static let bitCount = 2040
    public static let slots: [PolarSlot] = makeSlots()
    private static let gf = GF256()

    private static func makeSlots() -> [PolarSlot] {
        var inner: [PolarSlot] = [], cells: [String: [PolarSlot]] = [:]
        var placement = Random32(0x716ca2b5)
        while inner.count < bitCount - 512 {
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
        for i in 0..<512 {
            var t = (Double(i) + 0.5) * total / 512
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
        for i in 0..<223 {
            let coefficient = working[i]
            if coefficient == 0 { continue }
            for j in generator.indices { working[i + j] ^= gf.multiply(coefficient, generator[j]) }
        }
        return data + Array(working[223..<255])
    }

    public static func encodeBits(_ payload: String) throws -> [UInt8] {
        guard !payload.isEmpty else { throw PolarCodeError.emptyPayload }
        let utf8 = Array(payload.utf8)
        guard utf8.count <= payloadLimit else { throw PolarCodeError.payloadTooLong }
        let crc = crc32(utf8)
        var data = [Int](repeating: 0, count: 223)
        data[0] = 0x50; data[1] = 0x43; data[2] = 2
        data[3] = utf8.count >> 8; data[4] = utf8.count & 255
        data[5] = Int((crc >> 24) & 255); data[6] = Int((crc >> 16) & 255)
        data[7] = Int((crc >> 8) & 255); data[8] = Int(crc & 255)
        for i in utf8.indices { data[9 + i] = Int(utf8[i]) }
        var pad = Random32(0x759e2361)
        for i in (9 + utf8.count)..<223 { data[i] = Int(pad.next() & 255) }
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
        for p in 0..<255 {
            let power = gf.power(254 - p)
            let inverse = gf.power(-(254 - p))
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
        var data = [Int](repeating: 0, count: 255)
        var mask = Random32(0x2d943fa7)
        for i in bits.indices { data[i >> 3] |= (Int(bits[i]) ^ Int(mask.next() & 1)) << (7 - (i & 7)) }
        try correct(&data)
        guard data[0] == 0x50 && data[1] == 0x43 && data[2] == 2 else { throw PolarCodeError.invalidPayload }
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

    private static func markerDots(_ bytes: [UInt8], _ width: Int, _ height: Int) -> [MarkerDot] {
        var light = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height { for x in 0..<width {
            light[y * width + x] = luminance(bytes, width, x, y) > 205 ? 1 : 0
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
            if area < 11 || area > 130 || bw < 3 || bh < 3 || bw > 18 || bh > 18 || ratio < 0.55 || ratio > 1.8 { continue }
            dots.append(MarkerDot(x: Double(sumX) / Double(area), y: Double(sumY) / Double(area), area: area))
        }
        return Array(dots.sorted(by: { $0.area > $1.area }).prefix(180))
    }

    private static func waypointCandidates(_ dots: [MarkerDot]) -> [Waypoint] {
        var found: [Waypoint] = []
        for middle in dots {
            let near = dots.filter { dot in
                let d = hypot(dot.x - middle.x, dot.y - middle.y)
                return d >= 5 && d <= 23 && Double(max(dot.area, middle.area)) / Double(min(dot.area, middle.area)) < 2.6
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
                found.append(Waypoint(x: x, y: y, score: Double(a.area + middle.area + b.area) - offset * 2))
            }}
        }
        return Array(found.sorted(by: { $0.score > $1.score }).prefix(24))
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
        let waypoints = waypointCandidates(markerDots(bytes, width, height))
        let ratios: [Double] = [1, 0.66, 0.662, 0.75, 0.8, 0.9, 1.1] + (0...60).map { 0.6 + Double($0) * 0.01 }
        let offsets: [(Double, Double)] = [(0,0),(0,0.5),(0,-0.5),(-0.5,0),(0.5,0),(-0.5,-0.5),(0.5,0.5),(-0.5,0.5),(0.5,-0.5)]
        if waypoints.count < 2 { return nil }
        for i in 0..<(waypoints.count - 1) { for j in (i + 1)..<waypoints.count {
            let a = waypoints[i], b = waypoints[j], chord = hypot(a.x - b.x, a.y - b.y)
            if chord < 90 || chord > Double(max(width, height)) * 0.9 { continue }
            for (left, right) in [(a,b),(b,a)] { for q in ratios { for (ox, oy) in offsets {
                if let value = try? sample(bytes, width, height, left, right, q, ox, oy) { return value }
            }}}
        }}
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
            0.219 + 0.018 * sin(5 * a + 0.65) + 0.012 * cos(9 * a - 0.9) + 0.005 * sin(17 * a + 0.35)
        }
        context.setFillColor(color(4, 12, 22)); context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        circle(s / 2, s / 2, s * 0.475, color(16, 35, 56))
        let palette = [color(81,233,245), color(244,95,175), color(255,208,120), color(178,160,255)]
        var random = Random32(0x6f0b91e2)
        for i in 0..<36000 {
            let a = random.unit() * 2 * Double.pi
            let v = random.unit() * 2 * Double.pi
            let cross = sqrt(random.unit()) * 0.082
            let fold = 0.012 * sin(13 * a + 2.2 * v) + 0.006 * cos(23 * a - 3 * v)
            let r = ridge(a) + cross * cos(v) + fold
            let depth = cross * sin(v), angle = a + 0.011 * sin(7 * a + v)
            let x = s * (0.5 + r * cos(angle)), y = s * (0.5 + r * sin(angle) + depth * 0.48)
            let band = min(3, Int(floor((sin(2.9 * a + 19 * r + v * 0.36) + 1) * 1.999)))
            let light = 0.5 + 0.5 * max(0, sin(6 * a + v + r * 29))
            let opacity = i % 89 == 0 ? 0.96 : 0.48 + light * 0.47
            let dot = i % 89 == 0 ? 1.75 : i % 13 == 0 ? 1.12 : 0.58
            context.setAlpha(opacity)
            circle(x, y, dot * s / 800, palette[band])
        }
        context.setAlpha(1)
        for slot in slots where !slot.ring {
            circle(slot.x * s, slot.y * s, 1.85 * s / 800, color(16, 34, 53))
        }
        let dataColors = [color(163,238,242), color(255,180,221), color(255,225,161), color(203,195,255)]
        for (i, slot) in slots.enumerated() {
            let x = slot.x * s, y = slot.y * s
            if bits[i] == 1 {
                let angle = atan2(slot.y - 0.5, slot.x - 0.5)
                let band = min(3, Int(floor((sin(angle * 2.9 + Double(i) * 0.37) + 1) * 1.999)))
                circle(x, y, (slot.ring ? 1.7 : 1.78) * s / 800, slot.ring ? color(195,233,233) : dataColors[band])
            } else {
                circle(x, y, (slot.ring ? 1.275 : 1.335) * s / 800, slot.ring ? color(35,57,75) : color(38,60,80))
            }
        }
        for base in [5 * Double.pi / 4, 7 * Double.pi / 4] { for offset in [-0.029, 0.0, 0.029] {
            let angle = base + offset
            circle(s * (0.5 + 0.42 * cos(angle)), s * (0.5 + 0.42 * sin(angle)), 3.05 * s / 800, color(214,248,245))
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
