package com.scancode.asterhalo;

import android.graphics.Bitmap;
import android.graphics.Color;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;
import java.nio.charset.StandardCharsets;
import java.util.EnumMap;
import java.util.Map;

public final class AsterHalo {
    private AsterHalo() {}

    public static Bitmap encode(String payload, int pixels) {
        if (payload == null || payload.isEmpty()) throw new IllegalArgumentException("payload must be non-empty");
        if (payload.getBytes(StandardCharsets.UTF_8).length > 2048) throw new IllegalArgumentException("payload exceeds 2048 bytes");
        if (pixels < 256 || pixels > 4096) throw new IllegalArgumentException("pixels must be 256-4096");
        try {
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.H);
            hints.put(EncodeHintType.MARGIN, 4);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            var matrix = new QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, pixels, pixels, hints);
            int[] colors = new int[pixels * pixels];
            for (int y = 0; y < pixels; y++) for (int x = 0; x < pixels; x++)
                colors[y * pixels + x] = matrix.get(x, y) ? Color.rgb(7, 16, 29) : Color.rgb(248, 252, 255);
            return Bitmap.createBitmap(colors, pixels, pixels, Bitmap.Config.ARGB_8888);
        } catch (Exception error) {
            throw new IllegalArgumentException("QR generation failed", error);
        }
    }

    /** Decode the standard QR payload from a camera frame or image. */
    public static String decode(Bitmap bitmap) {
        if (bitmap == null) throw new IllegalArgumentException("bitmap is required");
        int width = bitmap.getWidth(), height = bitmap.getHeight();
        int[] pixels = new int[width * height];
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
        try {
            var source = new RGBLuminanceSource(width, height, pixels);
            var reader = new MultiFormatReader();
            Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
            hints.put(DecodeHintType.POSSIBLE_FORMATS, java.util.Collections.singletonList(BarcodeFormat.QR_CODE));
            return reader.decode(new BinaryBitmap(new HybridBinarizer(source)), hints).getText();
        } catch (Exception error) {
            return null;
        }
    }

    /** Decode a tightly packed camera Y plane. Callers should throttle frames and pass device rotation. */
    public static String decodeYPlane(byte[] luma, int width, int height, int rotationDegrees) {
        if (luma == null || luma.length < width * height || width <= 0 || height <= 0)
            throw new IllegalArgumentException("invalid Y plane");
        if (rotationDegrees != 0 && rotationDegrees != 90 && rotationDegrees != 180 && rotationDegrees != 270)
            throw new IllegalArgumentException("rotation must be 0, 90, 180 or 270");
        byte[] rotated = new byte[width * height];
        int outWidth = rotationDegrees % 180 == 0 ? width : height;
        int outHeight = rotationDegrees % 180 == 0 ? height : width;
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            int nx, ny;
            switch (rotationDegrees) {
                case 90: nx = height - 1 - y; ny = x; break;
                case 180: nx = width - 1 - x; ny = height - 1 - y; break;
                case 270: nx = y; ny = width - 1 - x; break;
                default: nx = x; ny = y;
            }
            rotated[ny * outWidth + nx] = luma[y * width + x];
        }
        try {
            var source = new PlanarYUVLuminanceSource(rotated, outWidth, outHeight, 0, 0, outWidth, outHeight, false);
            return new com.google.zxing.qrcode.QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source))).getText();
        } catch (Exception error) {
            return null;
        }
    }
}
