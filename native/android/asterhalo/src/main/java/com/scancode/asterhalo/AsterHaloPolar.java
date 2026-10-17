package com.scancode.asterhalo;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import com.google.zxing.common.reedsolomon.GenericGF;
import com.google.zxing.common.reedsolomon.ReedSolomonDecoder;
import com.google.zxing.common.reedsolomon.ReedSolomonEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.zip.CRC32;

/** AsterHalo's proprietary circular code and native Android frame decoder. */
public final class AsterHaloPolar {
    private static final int DATA_BYTES = 223, PARITY_BYTES = 32, CODE_BYTES = 255, BITS = 2040;
    private static final int MAX_PAYLOAD = 214;
    private static final Slot[] SLOTS = slots();
    private AsterHaloPolar() {}

    private static final class Random32 {
        int state;
        Random32(int seed) { state = seed; }
        int next() { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state; }
        double unit() { return Integer.toUnsignedLong(next()) / 4294967296.0; }
    }
    private static final class Slot {
        final double x, y;
        Slot(double x, double y) { this.x = x; this.y = y; }
    }
    private static final class Eye {
        final double x, y, diameter;
        Eye(double x, double y, double diameter) { this.x=x; this.y=y; this.diameter=diameter; }
    }
    private static final class Blob {
        final double x, y;
        final int width, height;
        Blob(double x,double y,int width,int height) { this.x=x;this.y=y;this.width=width;this.height=height; }
    }

    private static Slot[] slots() {
        List<Slot> all = new ArrayList<>();
        double[][] eyes = {{.22,.22},{.78,.22},{.22,.78}};
        for (int track=0;track<12;track++) {
            double radius=.338+track*(.12/11);
            int count=(int)Math.floor(2*Math.PI*radius*800/8.4);
            for(int sector=0;sector<count;sector++) {
                double angle=(sector+(track%2)*.5)*2*Math.PI/count-Math.PI/2;
                double displaced=radius+.0018*Math.sin(7*angle+.4);
                double x=.5+displaced*Math.cos(angle), y=.5+displaced*Math.sin(angle);
                boolean blocked=false;
                for(double[] eye:eyes) if(Math.hypot(x-eye[0],y-eye[1])<.052) {blocked=true;break;}
                if(!blocked) all.add(new Slot(x,y));
            }
        }
        Random32 shuffle=new Random32(0xa57e2c91);
        for(int i=all.size()-1;i>0;i--) {
            int j=(int)(Integer.toUnsignedLong(shuffle.next())%(i+1));
            Slot item=all.get(i);all.set(i,all.get(j));all.set(j,item);
        }
        if(all.size()<BITS) throw new IllegalStateException("polar geometry has insufficient capacity");
        return all.subList(0,BITS).toArray(new Slot[0]);
    }

    /** Exact UTF-8 payload to the shared 2,040-bit polar wire format. */
    public static byte[] encodeBits(String payload) {
        if(payload==null||payload.isEmpty()) throw new IllegalArgumentException("payload must be non-empty");
        byte[] utf8=payload.getBytes(StandardCharsets.UTF_8);
        if(utf8.length>MAX_PAYLOAD) throw new IllegalArgumentException("payload exceeds 214 UTF-8 bytes");
        int[] data=new int[CODE_BYTES];
        data[0]=0x50;data[1]=0x43;data[2]=1;data[3]=utf8.length>>>8;data[4]=utf8.length&255;
        CRC32 crc=new CRC32();crc.update(utf8);long check=crc.getValue();
        data[5]=(int)(check>>>24);data[6]=(int)(check>>>16)&255;data[7]=(int)(check>>>8)&255;data[8]=(int)check&255;
        for(int i=0;i<utf8.length;i++) data[9+i]=utf8[i]&255;
        Random32 pad=new Random32(0x759e2361);
        for(int i=9+utf8.length;i<DATA_BYTES;i++) data[i]=pad.next()&255;
        new ReedSolomonEncoder(GenericGF.QR_CODE_FIELD_256).encode(data,PARITY_BYTES);
        byte[] bits=new byte[BITS];Random32 mask=new Random32(0x2d943fa7);
        for(int i=0;i<BITS;i++) bits[i]=(byte)(((data[i>>>3]>>>(7-(i&7)))&1)^(mask.next()&1));
        return bits;
    }

    /** Corrects up to 16 erroneous bytes and checks the payload CRC. */
    public static String decodeBits(byte[] bits) {
        if(bits==null||bits.length!=BITS) throw new IllegalArgumentException("expected 2040 polar bits");
        int[] data=new int[CODE_BYTES];Random32 mask=new Random32(0x2d943fa7);
        for(int i=0;i<BITS;i++) {
            if(bits[i]!=0&&bits[i]!=1) throw new IllegalArgumentException("bits must be 0 or 1");
            data[i>>>3]|=(bits[i]^(mask.next()&1))<<(7-(i&7));
        }
        try { new ReedSolomonDecoder(GenericGF.QR_CODE_FIELD_256).decode(data,PARITY_BYTES); }
        catch(Exception error) { throw new IllegalArgumentException("polar error correction failed",error); }
        if(data[0]!=0x50||data[1]!=0x43||data[2]!=1) throw new IllegalArgumentException("polar marker invalid");
        int length=(data[3]<<8)|data[4];
        if(length<1||length>MAX_PAYLOAD) throw new IllegalArgumentException("polar length invalid");
        byte[] utf8=new byte[length];for(int i=0;i<length;i++) utf8[i]=(byte)data[9+i];
        CRC32 crc=new CRC32();crc.update(utf8);
        long expected=((long)data[5]<<24)|((long)data[6]<<16)|((long)data[7]<<8)|data[8];
        if(crc.getValue()!=expected) throw new IllegalArgumentException("polar checksum failed");
        try { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(utf8)).toString(); }
        catch(CharacterCodingException error) { throw new IllegalArgumentException("polar UTF-8 invalid",error); }
    }

    /** Static circular rendering. The moving vapor is added by AsterHaloView. */
    public static Bitmap render(String payload,int size) {
        if(size<600||size>4096) throw new IllegalArgumentException("size must be 600-4096");
        byte[] bits=encodeBits(payload);
        Bitmap image=Bitmap.createBitmap(size,size,Bitmap.Config.ARGB_8888);
        Canvas canvas=new Canvas(image);Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        canvas.drawColor(Color.rgb(4,12,22));
        paint.setColor(Color.rgb(16,35,56));canvas.drawCircle(size/2f,size/2f,size*.475f,paint);
        Random32 vapor=new Random32(0x6f0b91e2);
        int[] palette={0xff49e5f4,0xfff25cb3,0xfff0c46a,0xff839eff};
        for(int i=0;i<6200;i++) {
            double a=vapor.unit()*Math.PI*2, spread=(vapor.unit()+vapor.unit())/2;
            double wave=.026*Math.sin(5*a+.4)+.016*Math.cos(9*a-.5)+.008*Math.sin(16*a+.7);
            double radius=.158+.145*spread+wave;
            float x=(float)(size*(.5+radius*Math.cos(a))),y=(float)(size*(.5+radius*Math.sin(a)));
            int band=Math.min(3,(int)((Math.sin(a*3+radius*34)+1)*1.999));
            paint.setColor(palette[band]);paint.setAlpha(i%37==0?210:i%7==0?150:100);
            canvas.drawCircle(x,y,(i%37==0?1.8f:i%7==0?1.08f:.48f)*size/800f,paint);
        }
        for(int i=0;i<BITS;i++) {
            Slot slot=SLOTS[i];
            paint.setColor(bits[i]==1?(i%11==0?0xffe6fbff:i%5==0?0xffb4eff5:0xff8bdce8):0xff243a50);
            paint.setAlpha(255);
            canvas.drawCircle((float)(slot.x*size),(float)(slot.y*size),size*(bits[i]==1?2.25f:1.98f)/800f,paint);
        }
        double[][] eyes={{.22,.22},{.78,.22},{.22,.78}};
        for(double[] eye:eyes) {
            float x=(float)(eye[0]*size),y=(float)(eye[1]*size),s=size/800f;
            paint.setColor(0xffc9eff3);canvas.drawCircle(x,y,29*s,paint);
            paint.setColor(0xff0a1b2c);canvas.drawCircle(x,y,24*s,paint);
            paint.setColor(0xffd9f9f7);canvas.drawCircle(x,y,15*s,paint);
            paint.setColor(0xff0a1b2c);canvas.drawCircle(x,y,9*s,paint);
        }
        paint.setColor(0xff0e1d2d);canvas.drawCircle(size/2f,size/2f,size*.105f,paint);
        paint.setColor(0xffe9fcff);paint.setStrokeWidth(size*6/800f);paint.setStrokeCap(Paint.Cap.ROUND);
        canvas.drawLine(size*.484f,size*.466f,size*.498f,size*.508f,paint);
        canvas.drawLine(size*.498f,size*.508f,size*.528f,size*.494f,paint);
        canvas.drawLine(size*.498f,size*.508f,size*.476f,size*.529f,paint);
        return image;
    }

    private static int luma(int color) { return (Color.red(color)*54+Color.green(color)*183+Color.blue(color)*19)>>8; }

    private static List<Eye> findEyes(int[] pixels,int width,int height) {
        int factor=Math.max(1,(Math.max(width,height)+999)/1000),w=width/factor,h=height/factor;
        byte[] light=new byte[w*h],gray=new byte[w*h],seen=new byte[w*h];
        for(int y=0;y<h;y++)for(int x=0;x<w;x++) {
            int value=luma(pixels[Math.min(height-1,y*factor+factor/2)*width+Math.min(width-1,x*factor+factor/2)]);
            gray[y*w+x]=(byte)value;light[y*w+x]=(byte)(value>160?1:0);
        }
        int[] queue=new int[w*h];List<Blob> blobs=new ArrayList<>();
        for(int start=0;start<light.length;start++) {
            if(light[start]==0||seen[start]!=0)continue;
            int head=0,tail=0,area=0,minX=w,maxX=0,minY=h,maxY=0;long sumX=0,sumY=0;
            queue[tail++]=start;seen[start]=1;
            while(head<tail) {
                int p=queue[head++],x=p%w,y=p/w;area++;sumX+=x;sumY+=y;
                minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
                for(int oy=-1;oy<=1;oy++)for(int ox=-1;ox<=1;ox++) {
                    if(ox==0&&oy==0)continue;int nx=x+ox,ny=y+oy;
                    if(nx<0||ny<0||nx>=w||ny>=h)continue;int n=ny*w+nx;
                    if(light[n]!=0&&seen[n]==0){seen[n]=1;queue[tail++]=n;}
                }
            }
            int bw=maxX-minX+1,bh=maxY-minY+1;double fill=(double)area/(bw*bh);
            if(bw<12||bh<12||bw>Math.min(w,h)*.2||bh>Math.min(w,h)*.2||bw/(double)bh<.7||bw/(double)bh>1.3||fill<.12||fill>.72)continue;
            double cx=(double)sumX/area,cy=(double)sumY/area;
            if((gray[Math.round((float)cy)*w+Math.round((float)cx)]&255)>110)continue;
            blobs.add(new Blob(cx,cy,bw,bh));
        }
        List<Eye> eyes=new ArrayList<>();
        for(Blob outer:blobs) {
            boolean paired=false;
            for(Blob inner:blobs) {
                if(outer==inner)continue;
                double ratio=(double)outer.width/inner.width;
                if(ratio>1.55&&ratio<2.35&&Math.hypot(inner.x-outer.x,inner.y-outer.y)<outer.width*.08){paired=true;break;}
            }
            if(!paired)continue;
            boolean duplicate=false;
            for(Eye eye:eyes)if(Math.hypot(eye.x-outer.x*factor,eye.y-outer.y*factor)<outer.width*factor*.3){duplicate=true;break;}
            if(!duplicate)eyes.add(new Eye(outer.x*factor,outer.y*factor,outer.width*factor));
        }
        eyes.sort(Comparator.comparingDouble((Eye e)->e.diameter).reversed());
        return eyes.subList(0,Math.min(30,eyes.size()));
    }

    private static String sample(int[] pixels,int width,int height,Eye a,Eye b,Eye c) {
        byte[] bits=new byte[BITS];
        for(int i=0;i<BITS;i++) {
            Slot slot=SLOTS[i];double u=(slot.x-.22)/.56,v=(slot.y-.22)/.56;
            int x=(int)Math.round(a.x+u*(b.x-a.x)+v*(c.x-a.x));
            int y=(int)Math.round(a.y+u*(b.y-a.y)+v*(c.y-a.y));
            if(x<0||y<0||x>=width||y>=height)throw new IllegalArgumentException("symbol outside frame");
            bits[i]=(byte)(luma(pixels[y*width+x])>95?1:0);
        }
        return decodeBits(bits);
    }

    /** Finds the three eyes and decodes a full camera Bitmap; null means no readable code. */
    public static String decode(Bitmap bitmap) {
        if(bitmap==null)throw new IllegalArgumentException("bitmap is required");
        int width=bitmap.getWidth(),height=bitmap.getHeight();
        if(width<200||height<200)return null;
        int[] pixels=new int[width*height];bitmap.getPixels(pixels,0,width,0,0,width,height);
        List<Eye> eyes=findEyes(pixels,width,height);
        for(int i=0;i<eyes.size();i++)for(int j=i+1;j<eyes.size();j++)for(int k=j+1;k<eyes.size();k++) {
            Eye[] trio={eyes.get(i),eyes.get(j),eyes.get(k)};
            for(int corner=0;corner<3;corner++) {
                Eye a=trio[corner],b=trio[(corner+1)%3],c=trio[(corner+2)%3];
                double abx=b.x-a.x,aby=b.y-a.y,acx=c.x-a.x,acy=c.y-a.y;
                double lab=Math.hypot(abx,aby),lac=Math.hypot(acx,acy);
                if(lab<70||lac<70||Math.abs(lab-lac)/Math.max(lab,lac)>.35||Math.abs((abx*acx+aby*acy)/(lab*lac))>.35)continue;
                if(Math.max(a.diameter,Math.max(b.diameter,c.diameter))/Math.min(a.diameter,Math.min(b.diameter,c.diameter))>1.8)continue;
                try{return sample(pixels,width,height,a,b,c);}catch(Exception ignored){}
                try{return sample(pixels,width,height,a,c,b);}catch(Exception ignored){}
            }
        }
        return null;
    }
}
