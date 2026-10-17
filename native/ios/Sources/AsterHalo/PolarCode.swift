import Foundation
import CoreGraphics

public enum PolarCodeError: Error {
    case emptyPayload, payloadTooLong, invalidBits, errorCorrection, invalidPayload, invalidImage
}

public struct PolarSlot {
    public let x: Double
    public let y: Double
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

private struct Eye { let x: Double; let y: Double; let diameter: Double }
private struct Blob { let x: Double; let y: Double; let width: Int; let height: Int }

public enum AsterHaloPolar {
    public static let payloadLimit = 214
    public static let bitCount = 2040
    public static let slots: [PolarSlot] = makeSlots()
    private static let gf = GF256()

    private static func makeSlots() -> [PolarSlot] {
        var all: [PolarSlot] = []
        let eyes = [(0.22, 0.22), (0.78, 0.22), (0.22, 0.78)]
        for track in 0..<12 {
            let radius = 0.338 + Double(track) * (0.12 / 11)
            let count = Int(floor(2 * Double.pi * radius * 800 / 8.4))
            for sector in 0..<count {
                let angle = (Double(sector) + Double(track % 2) * 0.5) * 2 * Double.pi / Double(count) - Double.pi / 2
                let displaced = radius + 0.0018 * sin(7 * angle + 0.4)
                let x = 0.5 + displaced * cos(angle), y = 0.5 + displaced * sin(angle)
                if eyes.contains(where: { hypot(x - $0.0, y - $0.1) < 0.052 }) { continue }
                all.append(PolarSlot(x: x, y: y))
            }
        }
        var random = Random32(0xa57e2c91)
        for i in stride(from: all.count - 1, through: 1, by: -1) {
            let j = Int(random.next() % UInt32(i + 1))
            all.swapAt(i, j)
        }
        precondition(all.count >= bitCount)
        return Array(all.prefix(bitCount))
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
        data[0] = 0x50; data[1] = 0x43; data[2] = 1
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
        guard data[0] == 0x50 && data[1] == 0x43 && data[2] == 1 else { throw PolarCodeError.invalidPayload }
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

    private static func findEyes(_ bytes: [UInt8], _ width: Int, _ height: Int) -> [Eye] {
        let factor = max(1, (max(width, height) + 999) / 1000)
        let w = width / factor, h = height / factor
        var light = [UInt8](repeating: 0, count: w * h), gray = light, seen = light
        for y in 0..<h { for x in 0..<w {
            let value = luminance(bytes, width, min(width - 1, x * factor + factor / 2), min(height - 1, y * factor + factor / 2))
            gray[y * w + x] = UInt8(value); light[y * w + x] = value > 160 ? 1 : 0
        }}
        var blobs: [Blob] = [], queue = [Int](repeating: 0, count: w * h)
        for start in light.indices {
            if light[start] == 0 || seen[start] != 0 { continue }
            var head = 0, tail = 1, area = 0, minX = w, minY = h, maxX = 0, maxY = 0, sumX = 0, sumY = 0
            queue[0] = start; seen[start] = 1
            while head < tail {
                let p = queue[head]; head += 1
                let x = p % w, y = p / w
                area += 1; sumX += x; sumY += y
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                for oy in -1...1 { for ox in -1...1 {
                    if ox == 0 && oy == 0 { continue }
                    let nx = x + ox, ny = y + oy
                    if nx < 0 || ny < 0 || nx >= w || ny >= h { continue }
                    let next = ny * w + nx
                    if light[next] != 0 && seen[next] == 0 { seen[next] = 1; queue[tail] = next; tail += 1 }
                }}
            }
            let bw = maxX - minX + 1, bh = maxY - minY + 1
            let fill = Double(area) / Double(bw * bh), ratio = Double(bw) / Double(bh)
            if bw < 12 || bh < 12 || Double(bw) > Double(min(w,h)) * 0.2 || Double(bh) > Double(min(w,h)) * 0.2 || ratio < 0.7 || ratio > 1.3 || fill < 0.12 || fill > 0.72 { continue }
            let cx = Double(sumX) / Double(area), cy = Double(sumY) / Double(area)
            if gray[Int(cy.rounded()) * w + Int(cx.rounded())] > 110 { continue }
            blobs.append(Blob(x: cx, y: cy, width: bw, height: bh))
        }
        var eyes: [Eye] = []
        for outer in blobs {
            let paired = blobs.contains { inner in
                let ratio = Double(outer.width) / Double(inner.width)
                return ratio > 1.55 && ratio < 2.35 && hypot(inner.x - outer.x, inner.y - outer.y) < Double(outer.width) * 0.08
            }
            if !paired { continue }
            let x = outer.x * Double(factor), y = outer.y * Double(factor)
            if eyes.contains(where: { hypot($0.x - x, $0.y - y) < Double(outer.width * factor) * 0.3 }) { continue }
            eyes.append(Eye(x: x, y: y, diameter: Double(outer.width * factor)))
        }
        return Array(eyes.sorted(by: { $0.diameter > $1.diameter }).prefix(30))
    }

    private static func sample(_ bytes: [UInt8], _ width: Int, _ height: Int, _ a: Eye, _ b: Eye, _ c: Eye) throws -> String {
        var bits = [UInt8](repeating: 0, count: bitCount)
        for i in 0..<bitCount {
            let slot = slots[i], u = (slot.x - 0.22) / 0.56, v = (slot.y - 0.22) / 0.56
            let x = Int((a.x + u * (b.x - a.x) + v * (c.x - a.x)).rounded())
            let y = Int((a.y + u * (b.y - a.y) + v * (c.y - a.y)).rounded())
            guard x >= 0 && y >= 0 && x < width && y < height else { throw PolarCodeError.invalidImage }
            bits[i] = luminance(bytes, width, x, y) > 95 ? 1 : 0
        }
        return try decodeBits(bits)
    }

    /** Full-frame image scanner. Returns nil when no AsterHalo code is readable. */
    public static func decode(_ image: CGImage) -> String? {
        guard let bytes = try? rgba(image) else { return nil }
        let width = image.width, height = image.height, eyes = findEyes(bytes, width, height)
        if eyes.count < 3 { return nil }
        for i in 0..<eyes.count { for j in (i + 1)..<eyes.count { for k in (j + 1)..<eyes.count {
            let trio = [eyes[i], eyes[j], eyes[k]]
            for corner in 0..<3 {
                let a = trio[corner], b = trio[(corner + 1) % 3], c = trio[(corner + 2) % 3]
                let abx = b.x - a.x, aby = b.y - a.y, acx = c.x - a.x, acy = c.y - a.y
                let lab = hypot(abx, aby), lac = hypot(acx, acy)
                if lab < 70 || lac < 70 || abs(lab - lac) / max(lab, lac) > 0.35 || abs((abx * acx + aby * acy) / (lab * lac)) > 0.35 { continue }
                if max(a.diameter, b.diameter, c.diameter) / min(a.diameter, b.diameter, c.diameter) > 1.8 { continue }
                if let value = try? sample(bytes, width, height, a, b, c) { return value }
                if let value = try? sample(bytes, width, height, a, c, b) { return value }
            }
        }}}
        return nil
    }

    /** Render the same circular data ring as the web SDK, with a static vapor core. */
    public static func render(_ payload: String, size: Int = 800) throws -> CGImage {
        guard size >= 600 && size <= 4096 else { throw PolarCodeError.invalidImage }
        let bits = try encodeBits(payload)
        guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { throw PolarCodeError.invalidImage }
        func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) -> CGColor {
            CGColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
        }
        func circle(_ x: Double, _ y: Double, _ radius: Double, _ fill: CGColor) {
            context.setFillColor(fill)
            context.fillEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
        }
        let s = Double(size)
        context.setFillColor(color(4, 12, 22)); context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        circle(s / 2, s / 2, s * 0.475, color(16, 35, 56))
        var random = Random32(0x6f0b91e2)
        let palette = [color(73,229,244), color(242,92,179), color(240,196,106), color(131,158,255)]
        for i in 0..<6200 {
            let angle = random.unit() * Double.pi * 2
            let spread = (random.unit() + random.unit()) / 2
            let wave = 0.026 * sin(5 * angle + 0.4) + 0.016 * cos(9 * angle - 0.5) + 0.008 * sin(16 * angle + 0.7)
            let radius = 0.158 + 0.145 * spread + wave
            let x = s * (0.5 + radius * cos(angle)), y = s * (0.5 + radius * sin(angle))
            let band = min(3, Int((sin(angle * 3 + radius * 34) + 1) * 1.999))
            let opacity: CGFloat = i % 37 == 0 ? 0.82 : i % 7 == 0 ? 0.59 : 0.39
            context.setAlpha(opacity)
            circle(x, y, (i % 37 == 0 ? 1.8 : i % 7 == 0 ? 1.08 : 0.48) * s / 800, palette[band])
        }
        context.setAlpha(1)
        for i in 0..<bitCount {
            let fill = bits[i] == 1 ? (i % 11 == 0 ? color(230,251,255) : i % 5 == 0 ? color(180,239,245) : color(139,220,232)) : color(36,58,80)
            circle(slots[i].x * s, slots[i].y * s, (bits[i] == 1 ? 2.25 : 1.98) * s / 800, fill)
        }
        for (x, y) in [(0.22,0.22),(0.78,0.22),(0.22,0.78)] {
            circle(x * s, y * s, 29 * s / 800, color(201,239,243))
            circle(x * s, y * s, 24 * s / 800, color(10,27,44))
            circle(x * s, y * s, 15 * s / 800, color(217,249,247))
            circle(x * s, y * s, 9 * s / 800, color(10,27,44))
        }
        circle(s / 2, s / 2, s * 0.105, color(14,29,45))
        context.setStrokeColor(color(233,252,255)); context.setLineWidth(6 * CGFloat(s) / 800)
        context.setLineCap(.round)
        context.move(to: CGPoint(x: s * 0.484, y: s * 0.466)); context.addLine(to: CGPoint(x: s * 0.498, y: s * 0.508))
        context.addLine(to: CGPoint(x: s * 0.528, y: s * 0.494)); context.strokePath()
        context.move(to: CGPoint(x: s * 0.498, y: s * 0.508)); context.addLine(to: CGPoint(x: s * 0.476, y: s * 0.529)); context.strokePath()
        guard let image = context.makeImage() else { throw PolarCodeError.invalidImage }
        return image
    }
}
