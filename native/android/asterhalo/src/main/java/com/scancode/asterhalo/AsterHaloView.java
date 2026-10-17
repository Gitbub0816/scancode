package com.scancode.asterhalo;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

/** Native circular code display. Encoded particles and finder eyes stay fixed. */
public class AsterHaloView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private Bitmap symbol;
    private String payload;
    private boolean motion = true;
    private final long startedAt = System.nanoTime();
    private final ValueAnimator animator = ValueAnimator.ofFloat(0f, 1f);
    private static final int[] COLORS = {0xff49e5f4, 0xfff25cb3, 0xfff0c46a, 0xff839eff};

    public AsterHaloView(Context context) { super(context); setup(); }
    public AsterHaloView(Context context, AttributeSet attrs) { super(context, attrs); setup(); }
    public AsterHaloView(Context context, AttributeSet attrs, int style) { super(context, attrs, style); setup(); }

    private void setup() {
        setContentDescription("AsterHalo circular code");
        animator.setDuration(1000);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.addUpdateListener(value -> invalidate());
    }
    public void setPayload(String value) {
        symbol = AsterHaloPolar.render(value, 800);
        payload = value;
        invalidate();
    }
    public String getPayload() { return payload; }
    public void setMotionEnabled(boolean enabled) {
        motion = enabled;
        if (enabled && isAttachedToWindow()) animator.start(); else animator.cancel();
        invalidate();
    }
    @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); if (motion) animator.start(); }
    @Override protected void onDetachedFromWindow() { animator.cancel(); super.onDetachedFromWindow(); }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float size = Math.min(getWidth(), getHeight());
        float left = (getWidth() - size) / 2f, top = (getHeight() - size) / 2f;
        canvas.drawColor(0xff040c16);
        if (symbol != null) {
            paint.setAlpha(255);
            paint.setFilterBitmap(true);
            canvas.drawBitmap(symbol, null, new RectF(left, top, left + size, top + size), paint);
        }
        if (!motion || symbol == null) return;
        double t = (System.nanoTime() - startedAt) / 1_000_000_000.0;
        for (int i = 0; i < 2000; i++) {
            double phase = i * 2.399963229728653;
            double angle = phase + t * (.024 + (i % 9) * .0018);
            double spread = ((i * 73) % 997) / 997.0;
            double wave = .026 * Math.sin(5 * angle + .4 + t * .19)
                    + .016 * Math.cos(9 * angle - .5 - t * .12);
            double radius = Math.min(.318, .16 + .13 * spread + wave);
            float x = left + (float)(size * (.5 + radius * Math.cos(angle)));
            float y = top + (float)(size * (.5 + radius * Math.sin(angle)));
            paint.setColor(COLORS[i % COLORS.length]);
            paint.setAlpha(i % 19 == 0 ? 110 : 60);
            canvas.drawCircle(x, y, size * (i % 19 == 0 ? .0019f : .0008f), paint);
        }
        paint.setAlpha(255);
    }
}
