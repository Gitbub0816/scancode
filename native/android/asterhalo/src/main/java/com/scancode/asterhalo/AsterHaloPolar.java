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
        final Dot[] dots;
        Waypoint(double x,double y,double score,double spacing,Dot[] dots){this.x=x;this.y=y;this.score=score;this.spacing=spacing;this.dots=dots;}
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
        int[] palette={0xff45d8f2,0xfff051b0,0xfff0c86c,0xff62aee8};
        for(int i=0;i<30000;i++) {
            double a=random.unit()*2*Math.PI,v=random.unit()*2*Math.PI;
            double volume=.062+.014*Math.sin(4*a-.6)+.008*Math.cos(7*a+1.1);
            double cross=Math.sqrt(random.unit())*volume;
            double fold=.008*Math.sin(12*a+2.2*v)+.003*Math.cos(22*a-3*v);
            double ridge=.226+.013*Math.sin(5*a+.75)+.009*Math.cos(8*a-.8)+.005*Math.sin(14*a+.35);
            double r=ridge+cross*Math.cos(v)+fold;
            double depth=cross*Math.sin(v),angle=a+.011*Math.sin(7*a+v);
            float x=(float)(size*(.5+r*Math.cos(angle))),y=(float)(size*(.5+r*Math.sin(angle)+depth*.48));
            double chroma=Math.sin(2.8*a+2.2*Math.sin(v)+7*(r-ridge));
            int band=chroma>.38?1:chroma<-.38?0:Math.cos(4.8*a+v)>0?3:2;
            double depthLight=.43+.57*(.5+.5*Math.cos(v-.65));
            double light=(.42+.58*Math.max(0,Math.sin(6*a+v+r*29)))*depthLight;
            double opacity=i%137==0?.94:.29+light*.52;
            float dot=(float)(i%137==0?1.4:i%19==0?.94:.5);
            paint.setColor(palette[band]);paint.setAlpha((int)(opacity*255));
            canvas.drawCircle(x,y,dot*size/800f,paint);
        }
        paint.setAlpha(255);
        int[] dataColors={0xffb5f3f4,0xfff6b6de,0xffffe3aa,0xffa6cdeb};
        for(int i=0;i<BITS;i++) {
            Slot slot=SLOTS[i];
            float x=(float)(slot.x*size),y=(float)(slot.y*size);
            if(bits[i]==1) {
                double angle=Math.atan2(slot.y-.5,slot.x-.5);
                int band=Math.min(3,(int)Math.floor((Math.sin(angle*2.9+i*.37)+1)*1.999));
                paint.setColor(slot.ring?0xffc3e9e9:dataColors[band]);
                canvas.drawCircle(x,y,(slot.ring?2.4f:2.5f)*size/800f,paint);
            } else {
                paint.setColor(slot.ring?0xff263846:0xff172433);
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
        int[] dataColors={0xffb5f3f4,0xfff6b6de,0xffffe3aa,0xffa6cdeb};
        for(Slot slot:SLOTS)if(!slot.ring){paint.setColor(0xff172433);canvas.drawCircle((float)(slot.x*size),(float)(slot.y*size),2.65f*size/800f,paint);}
        for(int i=0;i<BITS;i++) {
            Slot slot=SLOTS[i];float x=(float)(slot.x*size),y=(float)(slot.y*size);
            if(bits[i]==1){
                double angle=Math.atan2(slot.y-.5,slot.x-.5);
                int band=Math.min(3,(int)Math.floor((Math.sin(angle*2.9+i*.37)+1)*1.999));
                paint.setColor(slot.ring?0xffc3e9e9:dataColors[band]);
                canvas.drawCircle(x,y,(slot.ring?2.4f:2.5f)*size/800f,paint);
            }else{
                paint.setColor(slot.ring?0xff263846:0xff172433);
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
        return dots.subList(0,Math.min(192,dots.size()));
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
                if(!duplicate)found.add(new Waypoint(x,y,a.area+middle.area+b.area-offset*2,(da+db)/2,new Dot[]{a,middle,b}));
            }
        }
        found.sort(Comparator.comparingDouble((Waypoint w)->w.score).reversed());
        return found.subList(0,Math.min(64,found.size()));
    }

    private static double[] project(double[] p,double u,double v) {
        double c=Math.cos(p[4]),s=Math.sin(p[4]),den=1+p[5]*v;
        return new double[]{p[0]+(p[2]*u*c-p[3]*v*s)/den,p[1]+(p[2]*u*s+p[3]*v*c)/den};
    }

    private static double[] inverse(double[] p,double x,double y) {
        double c=Math.cos(p[4]),s=Math.sin(p[4]),dx=x-p[0],dy=y-p[1];
        double uu=c*dx+s*dy,vv=-s*dx+c*dy,v=vv/(p[3]-p[5]*vv);
        return new double[]{uu*(1+p[5]*v)/p[2],v};
    }

    private static double[] initialProjection(Waypoint left,Waypoint right) {
        double chord=Math.hypot(right.x-left.x,right.y-left.y);
        double angle=Math.atan2(right.y-left.y,right.x-left.x),size=chord/(.42*Math.sqrt(2));
        return new double[]{(left.x+right.x)/2-.297*size*Math.sin(angle),
                (left.y+right.y)/2+.297*size*Math.cos(angle),size,size,angle,0};
    }

    private static boolean projectionInside(double[] p,int width,int height) {
        for(double[] uv:new double[][]{{.42,0},{-.42,0},{0,.42},{0,-.42}}) {
            double[] xy=project(p,uv[0],uv[1]);
            if(xy[0]<0||xy[1]<0||xy[0]>=width||xy[1]>=height)return false;
        }
        return true;
    }

    private static double fitLoss(double[] p,Dot[] observed,double[][] source,List<Dot> ring) {
        if(p[2]<100||p[3]<100||Math.abs(p[5])>1.5)return 1e15;
        double sum=0;
        for(int i=0;i<6;i++) {
            double[] xy=project(p,source[i][0],source[i][1]);
            sum+=.5*(Math.pow(xy[0]-observed[i].x,2)+Math.pow(xy[1]-observed[i].y,2));
        }
        for(Dot dot:ring) {
            double[] uv=inverse(p,dot.x,dot.y);double e=(Math.hypot(uv[0],uv[1])-.42)*1000;
            sum+=Math.min(e*e,4000);
        }
        return sum;
    }

    private static double[] fitProjection(Waypoint left,Waypoint right,List<Dot> dots) {
        double chord=Math.hypot(right.x-left.x,right.y-left.y);
        double angle=Math.atan2(right.y-left.y,right.x-left.x),size=chord/(.42*Math.sqrt(2));
        double midX=(left.x+right.x)/2,midY=(left.y+right.y)/2;
        double[] initial={midX-.297*size*Math.sin(angle),midY+.297*size*Math.cos(angle),size,size,angle,0};
        double axisX=(right.x-left.x)/chord,axisY=(right.y-left.y)/chord;
        Dot[] ld=left.dots.clone(),rd=right.dots.clone();
        Comparator<Dot> along=Comparator.comparingDouble(d->d.x*axisX+d.y*axisY);
        Arrays.sort(ld,along);Arrays.sort(rd,along);
        Dot[] observed={ld[0],ld[1],ld[2],rd[0],rd[1],rd[2]};
        double[][] source=new double[6][2];int n=0;
        for(double base:new double[]{5*Math.PI/4,7*Math.PI/4})for(double offset:new double[]{-.029,0,.029}) {
            source[n++]=new double[]{.42*Math.cos(base+offset),.42*Math.sin(base+offset)};
        }
        List<Dot> ring=new ArrayList<>();
        for(Dot dot:dots) {
            double[] uv=inverse(initial,dot.x,dot.y);double radius=Math.hypot(uv[0],uv[1]);
            if(radius>.34&&radius<.52&&dot.area<Math.max(50,left.score/2))ring.add(dot);
        }
        double[][] simplex=new double[7][];double[] values=new double[7];
        simplex[0]=initial;
        double[] steps={4,4,8,8,.007,.04};
        for(int i=0;i<6;i++){simplex[i+1]=initial.clone();simplex[i+1][i]+=steps[i];}
        for(int i=0;i<7;i++)values[i]=fitLoss(simplex[i],observed,source,ring);
        for(int iteration=0;iteration<450;iteration++) {
            Integer[] order={0,1,2,3,4,5,6};
            final double[] ranking=values;
            Arrays.sort(order,Comparator.comparingDouble(i->ranking[i]));
            double[][] sorted=new double[7][];double[] sortedValues=new double[7];
            for(int i=0;i<7;i++){sorted[i]=simplex[order[i]];sortedValues[i]=values[order[i]];}
            simplex=sorted;values=sortedValues;
            double[] center=new double[6];
            for(int i=0;i<6;i++)for(int j=0;j<6;j++)center[j]+=simplex[i][j]/6;
            double[] reflected=trial(center,simplex[6],1);
            double reflectedLoss=fitLoss(reflected,observed,source,ring);
            if(reflectedLoss<values[0]) {
                double[] expanded=trial(center,simplex[6],2);
                double expandedLoss=fitLoss(expanded,observed,source,ring);
                simplex[6]=expandedLoss<reflectedLoss?expanded:reflected;
                values[6]=Math.min(expandedLoss,reflectedLoss);
            } else if(reflectedLoss<values[5]) {simplex[6]=reflected;values[6]=reflectedLoss;}
            else {
                double[] contracted=trial(center,simplex[6],reflectedLoss<values[6] ? .5 : -.5);
                double contractedLoss=fitLoss(contracted,observed,source,ring);
                if(contractedLoss<Math.min(reflectedLoss,values[6])) {simplex[6]=contracted;values[6]=contractedLoss;}
                else for(int i=1;i<7;i++) {
                    double[] half=new double[6];for(int j=0;j<6;j++)half[j]=(simplex[0][j]+simplex[i][j])/2;
                    simplex[i]=half;values[i]=fitLoss(half,observed,source,ring);
                }
            }
        }
        int best=0;for(int i=1;i<7;i++)if(values[i]<values[best])best=i;
        return simplex[best];
    }

    private static double[] trial(double[] center,double[] worst,double factor) {
        double[] result=new double[6];for(int j=0;j<6;j++)result[j]=center[j]+factor*(center[j]-worst[j]);return result;
    }

    private static boolean waypointGeometry(Waypoint a,Waypoint b) {
        double chord=Math.hypot(b.x-a.x,b.y-a.y),axisX=(b.x-a.x)/chord,axisY=(b.y-a.y)/chord;
        double[][] tangent=new double[2][];Waypoint[] points={a,b};
        for(int i=0;i<2;i++) {
            Dot[] ordered=points[i].dots.clone();
            Arrays.sort(ordered,Comparator.comparingDouble(d->d.x*axisX+d.y*axisY));
            double dx=ordered[2].x-ordered[0].x,dy=ordered[2].y-ordered[0].y,len=Math.hypot(dx,dy);
            tangent[i]=new double[]{(dx*axisX+dy*axisY)/len,(axisX*dy-axisY*dx)/len};
        }
        return tangent[0][0]>.45&&tangent[0][0]<.92&&tangent[1][0]>.45&&tangent[1][0]<.92&&tangent[0][1]*tangent[1][1]<-.15;
    }

    private static int ringSupport(Waypoint left,Waypoint right,List<Dot> dots) {
        double chord=Math.hypot(right.x-left.x,right.y-left.y),angle=Math.atan2(right.y-left.y,right.x-left.x);
        double size=chord/(.42*Math.sqrt(2));
        double[] p={(left.x+right.x)/2-.297*size*Math.sin(angle),(left.y+right.y)/2+.297*size*Math.cos(angle),size,size,angle,0};
        boolean[] sectors=new boolean[16];int count=0;
        for(Dot dot:dots) {
            double[] uv=inverse(p,dot.x,dot.y);
            if(Math.abs(Math.hypot(uv[0],uv[1])-.42)>.035)continue;
            count++;
            int sector=(int)Math.floor((Math.atan2(uv[1],uv[0])+Math.PI)/(2*Math.PI)*16)%16;
            sectors[sector]=true;
        }
        for(boolean seen:sectors)if(seen)count+=6;
        return count;
    }

    private static double fieldContrast(int[] pixels,int width,int height,double[] p) {
        double[] values=new double[BITS];
        for(int i=0;i<BITS;i++) {
            double[] xy=project(p,SLOTS[i].x-.5,SLOTS[i].y-.5);
            int x=(int)Math.round(xy[0]),y=(int)Math.round(xy[1]);
            if(x<0||y<0||x>=width||y>=height)return Double.NEGATIVE_INFINITY;
            values[i]=luma(pixels[y*width+x]);
        }
        Arrays.sort(values);double score=0;
        for(int i=0;i<BITS/2;i++)score+=values[i+BITS/2]-values[i];
        return score;
    }

    private static double fieldVariance(int[] pixels,int width,int height,double[] p) {
        double sum=0,squares=0;
        for(Slot slot:SLOTS) {
            double[] xy=project(p,slot.x-.5,slot.y-.5);
            int x=(int)Math.round(xy[0]),y=(int)Math.round(xy[1]);
            if(x<0||y<0||x>=width||y>=height)return Double.NEGATIVE_INFINITY;
            double value=luma(pixels[y*width+x]);sum+=value;squares+=value*value;
        }
        double mean=sum/BITS;
        return squares/BITS-mean*mean;
    }

    private static double[] refineProjection(int[] pixels,int width,int height,double[] initial) {
        double[][] simplex=new double[7][];double[] values=new double[7];simplex[0]=initial;
        double[] steps={2,2,4,4,.005,.03};
        for(int i=0;i<6;i++){simplex[i+1]=initial.clone();simplex[i+1][i]+=steps[i];}
        for(int i=0;i<7;i++)values[i]=-fieldVariance(pixels,width,height,simplex[i]);
        for(int iteration=0;iteration<600;iteration++) {
            Integer[] order={0,1,2,3,4,5,6};final double[] ranking=values;
            Arrays.sort(order,Comparator.comparingDouble(i->ranking[i]));
            double[][] sorted=new double[7][];double[] sortedValues=new double[7];
            for(int i=0;i<7;i++){sorted[i]=simplex[order[i]];sortedValues[i]=values[order[i]];}
            simplex=sorted;values=sortedValues;
            double[] center=new double[6];
            for(int i=0;i<6;i++)for(int j=0;j<6;j++)center[j]+=simplex[i][j]/6;
            double[] reflected=trial(center,simplex[6],1);
            double reflectedLoss=-fieldVariance(pixels,width,height,reflected);
            if(reflectedLoss<values[0]) {
                double[] expanded=trial(center,simplex[6],2);
                double expandedLoss=-fieldVariance(pixels,width,height,expanded);
                simplex[6]=expandedLoss<reflectedLoss?expanded:reflected;
                values[6]=Math.min(expandedLoss,reflectedLoss);
            } else if(reflectedLoss<values[5]) {simplex[6]=reflected;values[6]=reflectedLoss;}
            else {
                double[] contracted=trial(center,simplex[6],reflectedLoss<values[6] ? .5 : -.5);
                double loss=-fieldVariance(pixels,width,height,contracted);
                if(loss<Math.min(reflectedLoss,values[6])) {simplex[6]=contracted;values[6]=loss;}
                else for(int i=1;i<7;i++) {
                    double[] half=new double[6];for(int j=0;j<6;j++)half[j]=(simplex[0][j]+simplex[i][j])/2;
                    simplex[i]=half;values[i]=-fieldVariance(pixels,width,height,half);
                }
            }
        }
        int best=0;for(int i=1;i<7;i++)if(values[i]<values[best])best=i;
        return simplex[best];
    }

    private static String sampleProjection(int[] pixels,int width,int height,double[] p) {
        byte[] bits=new byte[BITS];
        for(int i=0;i<BITS;i++) {
            double[] xy=project(p,SLOTS[i].x-.5,SLOTS[i].y-.5);
            int x=(int)Math.round(xy[0]),y=(int)Math.round(xy[1]);
            if(x<0||y<0||x>=width||y>=height)throw new IllegalArgumentException("symbol outside frame");
            bits[i]=(byte)(luma(pixels[y*width+x])>105?1:0);
        }
        return decodeBits(bits);
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
        List<Dot> dots=markerDots(pixels,width,height,threshold);
        List<Waypoint> points=waypointCandidates(dots);
        List<Waypoint[]> pairs=new ArrayList<>();
        for(int i=0;i<points.size();i++)for(int j=i+1;j<points.size();j++) {
            Waypoint a=points.get(i),b=points.get(j);double chord=Math.hypot(a.x-b.x,a.y-b.y);
            double ratio=chord/((a.spacing+b.spacing)/2);
            if(chord>=90&&chord<=Math.max(width,height)*.9&&ratio>=32&&ratio<=78&&waypointGeometry(a,b)&&
                    (projectionInside(initialProjection(a,b),width,height)||projectionInside(initialProjection(b,a),width,height)))pairs.add(new Waypoint[]{a,b});
        }
        pairs.sort(Comparator.comparingInt((Waypoint[] pair)->ringSupport(pair[0],pair[1],dots)).reversed());
        for(int pi=0;pi<Math.min(3,pairs.size());pi++)for(int order=0;order<2;order++) {
            Waypoint left=pairs.get(pi)[order],right=pairs.get(pi)[1-order];
            double[] fitted=fitProjection(left,right,dots);
            List<double[]> angles=new ArrayList<>();
            for(int i=0;i<=40;i++) {
                double[] projection=fitted.clone();projection[4]+=(i-20)*.002;
                angles.add(projection);
            }
            angles.sort(Comparator.comparingDouble((double[] p)->fieldContrast(pixels,width,height,p)).reversed());
            for(int ai=0;ai<Math.min(5,angles.size());ai++) {
                double[] angled=angles.get(ai);
                for(int step=0;step<=12;step++)for(int sign:new int[]{1,-1})for(int axis=0;axis<2;axis++) {
                    double dx=axis==0 ? sign*step*.5 : 0,dy=axis==1 ? sign*step*.5 : 0;
                    for(double extra:new double[]{0,.5,-.5}) {
                        double[] adjusted=angled.clone();adjusted[0]+=dx;adjusted[1]+=dy+extra;
                        try{return sampleProjection(pixels,width,height,adjusted);}catch(Exception ignored){}
                    }
                }
            }
            if(projectionInside(fitted,width,height)) {
                double[] refined=refineProjection(pixels,width,height,fitted);
                for(int ai=-4;ai<=4;ai++)for(int xi=-2;xi<=2;xi++)for(int yi=-2;yi<=2;yi++) {
                    double[] adjusted=refined.clone();adjusted[0]+=xi*.5;adjusted[1]+=yi*.5;adjusted[4]+=ai*.001;
                    try{return sampleProjection(pixels,width,height,adjusted);}catch(Exception ignored){}
                }
            }
        }
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
