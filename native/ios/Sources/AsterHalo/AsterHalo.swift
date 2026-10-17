import SwiftUI
import CoreImage.CIFilterBuiltins
import AVFoundation

public enum AsterHaloError: Error {
    case emptyPayload, payloadTooLong, generationFailed
}

public enum AsterHaloEncoder {
    /** Native AsterHalo Polar image. The custom scanner reads this format. */
    public static func polarImage(_ payload: String, size: Int = 800) throws -> CGImage {
        try AsterHaloPolar.render(payload, size: size)
    }

    /** Optional conventional QR compatibility path; not used by AsterHaloView. */
    public static func qrImage(_ payload: String) throws -> CGImage {
        guard !payload.isEmpty else { throw AsterHaloError.emptyPayload }
        guard payload.utf8.count <= 2048 else { throw AsterHaloError.payloadTooLong }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "H"
        guard let output = filter.outputImage,
              let image = CIContext().createCGImage(output, from: output.extent) else {
            throw AsterHaloError.generationFailed
        }
        return image
    }
}

public struct AsterHaloView: View {
    public let payload: String
    public var animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(payload: String, mark: String = "", animated: Bool = true) {
        self.payload = payload
        self.animated = animated
    }

    public var body: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let image = try? AsterHaloPolar.render(payload)
            ZStack {
                Color(red: 4/255, green: 12/255, blue: 22/255)
                if let image {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: size, height: size)
                }
                if animated && !reduceMotion {
                    TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                        Canvas { context, canvasSize in
                            let t = timeline.date.timeIntervalSinceReferenceDate
                            let width = min(canvasSize.width, canvasSize.height)
                            for i in 0..<2200 {
                                let phase = Double(i) * 2.399963229728653
                                let a = phase + t * (0.025 + Double(i % 9) * 0.0018)
                                let spread = Double((i * 73) % 997) / 997
                                let waveA = 0.026 * sin(5 * a + 0.4 + t * 0.19)
                                let waveB = 0.016 * cos(9 * a - 0.5 - t * 0.12)
                                let wave = waveA + waveB
                                let r = min(0.318, 0.16 + 0.13 * spread + wave)
                                let x = width * (0.5 + r * cos(a)), y = width * (0.5 + r * sin(a))
                                let diameter = width * (i % 19 == 0 ? 0.0025 : 0.0012)
                                let color: Color = i % 4 == 0 ? .cyan : i % 4 == 1 ? .pink : i % 4 == 2 ? .yellow : .blue
                                context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: diameter, height: diameter)), with: .color(color.opacity(0.45)))
                            }
                            // Cover moving particles at every sampling point, then redraw the fixed code.
                            if let bits = try? AsterHaloPolar.encodeBits(payload) {
                                for slot in AsterHaloPolar.slots where !slot.ring {
                                    let d = width * 5.3 / 800
                                    let rect = CGRect(x: slot.x * width - d / 2, y: slot.y * width - d / 2, width: d, height: d)
                                    context.fill(Path(ellipseIn: rect), with: .color(Color(red: 32/255, green: 57/255, blue: 74/255)))
                                }
                                let bright: [Color] = [Color(red: 163/255, green: 238/255, blue: 242/255), Color(red: 1, green: 180/255, blue: 221/255), Color(red: 1, green: 225/255, blue: 161/255), Color(red: 203/255, green: 195/255, blue: 1)]
                                for (index, slot) in AsterHaloPolar.slots.enumerated() {
                                    let angle = atan2(slot.y - 0.5, slot.x - 0.5)
                                    let band = min(3, Int(floor((sin(angle * 2.9 + Double(index) * 0.37) + 1) * 1.999)))
                                    let on = bits[index] == 1
                                    let color = on ? (slot.ring ? Color(red: 195/255, green: 233/255, blue: 233/255) : bright[band]) : (slot.ring ? Color(red: 35/255, green: 57/255, blue: 75/255) : Color(red: 32/255, green: 57/255, blue: 74/255))
                                    let d = width * (on ? (slot.ring ? 4.8 : 5.0) : (slot.ring ? 3.6 : 5.3)) / 800
                                    context.fill(Path(ellipseIn: CGRect(x: slot.x * width - d / 2, y: slot.y * width - d / 2, width: d, height: d)), with: .color(color))
                                }
                            }
                        }
                    }
                }
            }
            .frame(width: size, height: size)
            .accessibilityLabel("AsterHalo Polar code")
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

public struct AsterHaloScanner: UIViewControllerRepresentable {
    public let onResult: (String) -> Void
    public init(onResult: @escaping (String) -> Void) { self.onResult = onResult }
    public func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onResult = onResult
        return controller
    }
    public func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.onResult = onResult
    }
}

public final class ScannerController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate {
    public var onResult: ((String) -> Void)?
    private let session = AVCaptureSession()
    private let imageContext = CIContext()
    private let frameQueue = DispatchQueue(label: "AsterHaloPolar.camera", qos: .userInitiated)
    private var preview: AVCaptureVideoPreviewLayer?
    private var lastPayload = ""
    private var lastResultAt = Date.distantPast
    private var lastFrameAt = Date.distantPast

    public override func viewDidLoad() {
        super.viewDidLoad()
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setSampleBufferDelegate(self, queue: frameQueue)
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
    }
    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }
    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        frameQueue.async { self.session.startRunning() }
    }
    public override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        frameQueue.async { self.session.stopRunning() }
    }
    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = Date()
        if now.timeIntervalSince(lastFrameAt) < 0.35 { return }
        lastFrameAt = now
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let source = CIImage(cvPixelBuffer: buffer)
        guard let image = imageContext.createCGImage(source, from: source.extent),
              let payload = AsterHaloPolar.decode(image) else { return }
        if payload == lastPayload && now.timeIntervalSince(lastResultAt) < 2 { return }
        lastPayload = payload
        lastResultAt = now
        DispatchQueue.main.async { self.onResult?(payload) }
    }
}
