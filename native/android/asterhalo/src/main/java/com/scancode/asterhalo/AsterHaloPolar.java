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
import java.util.Map;
import java.util.HashMap;
import java.util.zip.CRC32;

/** AsterHalo's proprietary circular code and native Android frame decoder. */
public final class AsterHaloPolar {
    private static final int DATA_BYTES = 96, PARITY_BYTES = 32, CODE_BYTES = 128, BITS = 1024;
    private static final int MAX_PAYLOAD = 87;
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
        final boolean ring;
        Slot(double x, double y, boolean ring) { this.x = x; this.y = y; this.ring = ring; }
    }
    private static final class Dot {
        final double x,y;final int area;
        Dot(double x,double y,int area){this.x=x;this.y=y;this.area=area;}
    }
    private static final class Waypoint {
        final double x,y,score,spacing;
        Waypoint(double x,double y,double score,double spacing){this.x=x;this.y=y;this.score=score;this.spacing=spacing;}
    }

    private static Slot[] slots() {
        List<Slot> inner=new ArrayList<>();
        Map<String,List<Slot>> cells=new HashMap<>();
        Random32 placement=new Random32(0x716ca2b5);
        while(inner.size()<BITS-256) {
            double angle=placement.unit()*2*Math.PI;
            double radial=placement.unit();
            double radius=Math.sqrt(.14*.14+radial*(.305*.305-.14*.14));
            double x=.5+radius*Math.cos(angle),y=.5+radius*Math.sin(angle);
            int gx=(int)Math.floor(x/.007),gy=(int)Math.floor(y/.007);
            boolean near=false;
            for(int dx=-1;dx<=1;dx++)for(int dy=-1;dy<=1;dy++) {
                List<Slot> previous=cells.get((gx+dx)+","+(gy+dy));
                if(previous==null)continue;
                for(Slot slot:previous)if(Math.hypot(x-slot.x,y-slot.y)<.0065){near=true;break;}
            }
            if(near)continue;
            Slot slot=new Slot(x,y,false);inner.add(slot);
            cells.computeIfAbsent(gx+","+gy,key->new ArrayList<>()).add(slot);
        }
        double gap=.06,m1=5*Math.PI/4,m2=7*Math.PI/4;
        double[][] ranges={{0,m1-gap},{m1+gap,m2-gap},{m2+gap,2*Math.PI}};
        double total=0;for(double[] range:ranges)total+=range[1]-range[0];
        List<Slot> all=new ArrayList<>(inner);
        for(int i=0;i<256;i++) {
            double t=(i+.5)*total/256,angle=0;
            for(double[] range:ranges){if(t<range[1]-range[0]){angle=range[0]+t;break;}t-=range[1]-range[0];}
            all.add(new Slot(.5+.42*Math.cos(angle),.5+.42*Math.sin(angle),true));
        }
        Random32 shuffle=new Random32(0xa57e2c91);
        for(int i=all.size()-1;i>0;i--) {
            int j=(int)(Integer.toUnsignedLong(shuffle.next())%(i+1));
            Slot item=all.get(i);all.set(i,all.get(j));all.set(j,item);
        }
        if(all.size()!=BITS)throw new IllegalStateException("polar geometry capacity mismatch");
        return all.toArray(new Slot[0]);
    }

    /** Exact UTF-8 payload to the shared 1,024-bit polar wire format. */
    public static byte[] encodeBits(String payload) {
        if(payload==null||payload.isEmpty()) throw new IllegalArgumentException("payload must be non-empty");
        byte[] utf8=payload.getBytes(StandardCharsets.UTF_8);
        if(utf8.length>MAX_PAYLOAD) throw new IllegalArgumentException("payload exceeds 87 UTF-8 bytes");
        int[] data=new int[CODE_BYTES];
        data[0]=0x50;data[1]=0x43;data[2]=3;data[3]=utf8.length>>>8;data[4]=utf8.length&255;
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
        if(bits==null||bits.length!=BITS) throw new IllegalArgumentException("expected 1024 polar bits");
        int[] data=new int[CODE_BYTES];Random32 mask=new Random32(0x2d943fa7);
        for(int i=0;i<BITS;i++) {
            if(bits[i]!=0&&bits[i]!=1) throw new IllegalArgumentException("bits must be 0 or 1");
            data[i>>>3]|=(bits[i]^(mask.next()&1))<<(7-(i&7));
        }
        try { new ReedSolomonDecoder(GenericGF.QR_CODE_FIELD_256).decode(data,PARITY_BYTES); }
        catch(Exception error) { throw new IllegalArgumentException("polar error correction failed",error); }
        if(data[0]!=0x50||data[1]!=0x43||data[2]!=3) throw new IllegalArgumentException("polar marker invalid");
        int length=(data[3]<<8)|data[4];
        if(length<1||length>MAX_PAYLOAD) throw new IllegalArgumentException("polar length invalid");
        byte[] utf8=new byte[length];for(int i=0;i<length;i++) utf8[i]=(byte)data[9+i];
        CRC32 crc=new CRC32();crc.update(utf8);
        long expected=((long)data[5]<<24)|((long)data[6]<<16)|((long)data[7]<<8)|data[8];
        if(crc.getValue()!=expected) throw new IllegalArgumentException("polar checksum failed");
        try { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(utf8)).toString(); }
        catch(CharacterCodingException error) { throw new IllegalArgumentException("polar UTF-8 invalid",error); }
    }

    /** Static one-row ring and encoded particle cloud. */
    public static Bitmap render(String payload,int size) {
        if(size<600||size>4096)throw new IllegalArgumentException("size must be 600-4096");
        byte[] bits=encodeBits(payload);
        Bitmap image=Bitmap.createBitmap(size,size,Bitmap.Config.ARGB_8888);
        Canvas canvas=new Canvas(image);Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        canvas.drawColor(0xff040c16);
        paint.setColor(0xff102338);canvas.drawCircle(size/2f,size/2f,size*.475f,paint);
        Random32 random=new Random32(0x6f0b91e2);
        int[] palette={0xff51e9f5,0xfff45faf,0xffffd078,0xff588dd5};
        for(int i=0;i<30000;i++) {
            double a=random.unit()*2*Math.PI,v=random.unit()*2*Math.PI;
            double cross=Math.sqrt(random.unit())*.075;
            double fold=.004*Math.sin(13*a+2.2*v)+.002*Math.cos(23*a-3*v);
            double r=.235+.012*Math.sin(5*a+.65)+.008*Math.cos(9*a-.9)+.004*Math.sin(17*a+.35)+cross*Math.cos(v)+fold;
            double depth=cross*Math.sin(v),angle=a+.011*Math.sin(7*a+v);
            float x=(float)(size*(.5+r*Math.cos(angle))),y=(float)(size*(.5+r*Math.sin(angle)+depth*.48));
            int band=Math.min(3,(int)Math.floor((Math.sin(2.9*a+19*r+v*.36)+1)*1.999));
            double light=.5+.5*Math.max(0,Math.sin(6*a+v+r*29));
            double opacity=i%89==0?.96:.3+light*.42;
            float dot=(float)(i%89==0?1.75:i%13==0?1.12:.58);
            paint.setColor(palette[band]);paint.setAlpha((int)(opacity*255));
            canvas.drawCircle(x,y,dot*size/800f,paint);
        }
        paint.setAlpha(255);
        int[] dataColors={0xffa3eef2,0xffffb4dd,0xffffe1a1,0xff91b9e3};
        for(int i=0;i<BITS;i++) {
            Slot slot=SLOTS[i];
            float x=(float)(slot.x*size),y=(float)(slot.y*size);
            if(bits[i]==1) {
                double angle=Math.atan2(slot.y-.5,slot.x-.5);
                int band=Math.min(3,(int)Math.floor((Math.sin(angle*2.9+i*.37)+1)*1.999));
                paint.setColor(slot.ring?0xffc3e9e9:dataColors[band]);
                canvas.drawCircle(x,y,(slot.ring?2.4f:2.5f)*size/800f,paint);
            } else {
                paint.setColor(slot.ring?0xff23394b:0xff20394a);
                canvas.drawCircle(x,y,(slot.ring?1.8f:2.65f)*size/800f,paint);
            }
        }
        paint.setColor(0xffd6f8f5);
        for(double base:new double[]{5*Math.PI/4,7*Math.PI/4})for(double offset:new double[]{-.029,0,.029}) {
            double angle=base+offset;
            canvas.drawCircle((float)(size*(.5+.42*Math.cos(angle))),(float)(size*(.5+.42*Math.sin(angle))),3.65f*size/800f,paint);
        }
        paint.setStyle(Paint.Style.STROKE);paint.setColor(0x7270d6e2);paint.setStrokeWidth(1.5f*size/800f);
        canvas.drawCircle(size/2f,size/2f,size*.475f,paint);
        paint.setColor(0xffe9fcff);paint.setStrokeWidth(6f*size/800f);paint.setStrokeCap(Paint.Cap.ROUND);
        canvas.drawLine(size*.484f,size*.466f,size*.498f,size*.508f,paint);
        canvas.drawLine(size*.498f,size*.508f,size*.528f,size*.494f,paint);
        canvas.drawLine(size*.498f,size*.508f,size*.476f,size*.529f,paint);
        return image;
    }

    /** Transparent fixed data layer for display above moving particles. */
    public static Bitmap renderDataLayer(String payload,int size) {
        if(size<600||size>4096)throw new IllegalArgumentException("size must be 600-4096");
        byte[] bits=encodeBits(payload);
        Bitmap image=Bitmap.createBitmap(size,size,Bitmap.Config.ARGB_8888);
        Canvas canvas=new Canvas(image);Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        int[] dataColors={0xffa3eef2,0xffffb4dd,0xffffe1a1,0xff91b9e3};
        for(Slot slot:SLOTS)if(!slot.ring){paint.setColor(0xff20394a);canvas.drawCircle((float)(slot.x*size),(float)(slot.y*size),2.65f*size/800f,paint);}
        for(int i=0;i<BITS;i++) {
            Slot slot=SLOTS[i];float x=(float)(slot.x*size),y=(float)(slot.y*size);
            if(bits[i]==1){
                double angle=Math.atan2(slot.y-.5,slot.x-.5);
                int band=Math.min(3,(int)Math.floor((Math.sin(angle*2.9+i*.37)+1)*1.999));
                paint.setColor(slot.ring?0xffc3e9e9:dataColors[band]);
                canvas.drawCircle(x,y,(slot.ring?2.4f:2.5f)*size/800f,paint);
            }else{
                paint.setColor(slot.ring?0xff23394b:0xff20394a);
                canvas.drawCircle(x,y,(slot.ring?1.8f:2.65f)*size/800f,paint);
            }
        }
        paint.setColor(0xffd6f8f5);
        for(double base:new double[]{5*Math.PI/4,7*Math.PI/4})for(double offset:new double[]{-.029,0,.029}) {
            double angle=base+offset;
            canvas.drawCircle((float)(size*(.5+.42*Math.cos(angle))),(float)(size*(.5+.42*Math.sin(angle))),3.65f*size/800f,paint);
        }
        return image;
    }

    private static boolean neutral(int color,int threshold) { int r=Color.red(color),g=Color.green(color),b=Color.blue(color); return r>threshold&&g>threshold&&b>threshold&&Math.max(r,Math.max(g,b))-Math.min(r,Math.min(g,b))<68; }

    private static int luma(int color) { return (Color.red(color)*54+Color.green(color)*183+Color.blue(color)*19)>>8; }

    private static List<Dot> markerDots(int[] pixels,int width,int height,int threshold) {
        byte[] light=new byte[width*height],seen=new byte[width*height];
        for(int y=0;y<height;y++)for(int x=0;x<width;x++)light[y*width+x]=(byte)(neutral(pixels[y*width+x],threshold)?1:0);
        int[] queue=new int[width*height];List<Dot> dots=new ArrayList<>();
        for(int start=0;start<light.length;start++) {
            if(light[start]==0||seen[start]!=0)continue;
            int head=0,tail=1,area=0,minX=width,maxX=0,minY=height,maxY=0;long sumX=0,sumY=0;
            queue[0]=start;seen[start]=1;
            while(head<tail) {
                int p=queue[head++],x=p%width,y=p/width;area++;sumX+=x;sumY+=y;
                minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
                for(int oy=-1;oy<=1;oy++)for(int ox=-1;ox<=1;ox++) {
                    if(ox==0&&oy==0)continue;int nx=x+ox,ny=y+oy;
                    if(nx<0||ny<0||nx>=width||ny>=height)continue;int n=ny*width+nx;
                    if(light[n]!=0&&seen[n]==0){seen[n]=1;queue[tail++]=n;}
                }
            }
            int bw=maxX-minX+1,bh=maxY-minY+1;double ratio=(double)bw/bh;
            if(area<3||area>130||bw<2||bh<2||bw>18||bh>18||ratio<.55||ratio>1.8)continue;
            dots.add(new Dot((double)sumX/area,(double)sumY/area,area));
        }
        dots.sort(Comparator.comparingInt((Dot dot)->dot.area).reversed());
        return dots.subList(0,Math.min(96,dots.size()));
    }

    private static List<Waypoint> waypointCandidates(List<Dot> dots) {
        List<Waypoint> found=new ArrayList<>();
        for(Dot middle:dots) {
            List<Dot> near=new ArrayList<>();
            for(Dot dot:dots){double d=Math.hypot(dot.x-middle.x,dot.y-middle.y);
                if(d>=3&&d<=23&&(double)Math.max(dot.area,middle.area)/Math.min(dot.area,middle.area)<2.6)near.add(dot);
            }
            for(int i=0;i<near.size();i++)for(int j=i+1;j<near.size();j++) {
                Dot a=near.get(i),b=near.get(j);
                double ax=a.x-middle.x,ay=a.y-middle.y,bx=b.x-middle.x,by=b.y-middle.y;
                double da=Math.hypot(ax,ay),db=Math.hypot(bx,by);
                if(Math.abs(da-db)/Math.max(da,db)>.32||(ax*bx+ay*by)/(da*db)>-.86)continue;
                double offset=Math.hypot((a.x+b.x)/2-middle.x,(a.y+b.y)/2-middle.y);
                if(offset>Math.max(2.6,.24*Math.max(da,db)))continue;
                double x=(a.x+middle.x+b.x)/3,y=(a.y+middle.y+b.y)/3;
                boolean duplicate=false;for(Waypoint w:found)if(Math.hypot(w.x-x,w.y-y)<5){duplicate=true;break;}
                if(!duplicate)found.add(new Waypoint(x,y,a.area+middle.area+b.area-offset*2,(da+db)/2));
            }
        }
        found.sort(Comparator.comparingDouble((Waypoint w)->w.score).reversed());
        return found.subList(0,Math.min(16,found.size()));
    }

    private static String sample(int[] pixels,int width,int height,Waypoint a,Waypoint b,double q,double offsetX,double offsetY) {
        double dx=b.x-a.x,dy=b.y-a.y,chord=Math.hypot(dx,dy),cos=dx/chord,sin=dy/chord;
        double sizeX=chord/(.42*Math.sqrt(2)),sizeY=sizeX*q;
        double cx=(a.x+b.x)/2-sin*chord*q/2+offsetX,cy=(a.y+b.y)/2+cos*chord*q/2+offsetY;
        byte[] bits=new byte[BITS];
        for(int i=0;i<BITS;i++) {
            Slot slot=SLOTS[i];double xx=(slot.x-.5)*sizeX,yy=(slot.y-.5)*sizeY;
            int x=(int)Math.round(cx+xx*cos-yy*sin),y=(int)Math.round(cy+xx*sin+yy*cos);
            if(x<0||y<0||x>=width||y>=height)throw new IllegalArgumentException("symbol outside frame");
            bits[i]=(byte)(luma(pixels[y*width+x])>95?1:0);
        }
        return decodeBits(bits);
    }

    /** Reads the one-row ring and cloud using two three-dot waypoints. */
    public static String decode(Bitmap bitmap) {
        if(bitmap==null)throw new IllegalArgumentException("bitmap is required");
        int width=bitmap.getWidth(),height=bitmap.getHeight();if(width<200||height<200)return null;
        int[] pixels=new int[width*height];bitmap.getPixels(pixels,0,width,0,0,width,height);
        double[] ratios={1,.66,.662,.75,.8,.9,1.1};
        double[][] offsets={{0,0},{0,.5},{0,-.5},{-.5,0},{.5,0},{-.5,-.5},{.5,.5},{-.5,.5},{.5,-.5}};
        for(int threshold:new int[]{185,170}) {
        List<Waypoint> points=waypointCandidates(markerDots(pixels,width,height,threshold));
        for(int i=0;i<points.size();i++)for(int j=i+1;j<points.size();j++) {
            Waypoint first=points.get(i),second=points.get(j);double chord=Math.hypot(first.x-second.x,first.y-second.y);
            if(chord<90||chord>Math.max(width,height)*.9)continue;
            double spacingRatio=chord/((first.spacing+second.spacing)/2);
            if(spacingRatio<32||spacingRatio>78)continue;
            for(int order=0;order<2;order++) {
                Waypoint a=order==0?first:second,b=order==0?second:first;
                for(int pass=0;pass<2;pass++)for(int ri=0;ri<(pass==0?ratios.length:61);ri++) {
                    double q=pass==0?ratios[ri]:.6+ri*.01;
                    for(double[] offset:offsets)try{return sample(pixels,width,height,a,b,q,offset[0],offset[1]);}catch(Exception ignored){}
                }
            }
        }
        }
        return null;
    }
}
