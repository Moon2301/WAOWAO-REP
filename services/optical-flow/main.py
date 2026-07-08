import io
import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import Response
from raft_model import compute_flow_raft

app = FastAPI(title="Optical Flow Service")

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.post("/api/v1/flow")
async def compute_flow(
    image1: UploadFile = File(...),
    image2: UploadFile = File(...)
):
    """
    Computes optical flow between image1 and image2.
    Returns the motion vector field as a NumPy binary (.npy).
    """
    try:
        content1 = await image1.read()
        content2 = await image2.read()

        # Decode images
        nparr1 = np.frombuffer(content1, np.uint8)
        img1 = cv2.imdecode(nparr1, cv2.IMREAD_COLOR)
        
        nparr2 = np.frombuffer(content2, np.uint8)
        img2 = cv2.imdecode(nparr2, cv2.IMREAD_COLOR)

        if img1 is None or img2 is None:
            raise HTTPException(status_code=400, detail="Invalid image files")

        # Compute flow using RAFT
        flow_vectors = compute_flow_raft(img1, img2)

        # Save to buffer as .npy
        out_buffer = io.BytesIO()
        np.save(out_buffer, flow_vectors)
        out_buffer.seek(0)

        return Response(content=out_buffer.getvalue(), media_type="application/octet-stream")

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/v1/warp")
async def warp_image(
    image1: UploadFile = File(...),
    image2: UploadFile = File(...),
    processed_image1: UploadFile = File(...)
):
    """
    Computes flow between image1 and image2, then warps processed_image1 
    to align with image2 using the computed flow.
    Returns the warped image as JPEG.
    """
    try:
        content1 = await image1.read()
        content2 = await image2.read()
        content3 = await processed_image1.read()

        # Decode images
        img1 = cv2.imdecode(np.frombuffer(content1, np.uint8), cv2.IMREAD_COLOR)
        img2 = cv2.imdecode(np.frombuffer(content2, np.uint8), cv2.IMREAD_COLOR)
        proc_img1 = cv2.imdecode(np.frombuffer(content3, np.uint8), cv2.IMREAD_COLOR)

        if img1 is None or img2 is None or proc_img1 is None:
            raise HTTPException(status_code=400, detail="Invalid image files")

        # Compute flow using RAFT
        flow_vectors = compute_flow_raft(img1, img2)

        # Warp proc_img1 using flow
        h, w = proc_img1.shape[:2]
        
        # flow_vectors is HxWx2 (dx, dy)
        # Create meshgrid
        x, y = np.meshgrid(np.arange(w), np.arange(h))
        
        # map_x = x + dx, map_y = y + dy
        map_x = (x + flow_vectors[..., 0]).astype(np.float32)
        map_y = (y + flow_vectors[..., 1]).astype(np.float32)
        
        # Remap
        warped = cv2.remap(proc_img1, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        
        # Encode to JPEG
        is_success, buffer = cv2.imencode(".jpg", warped)
        if not is_success:
            raise HTTPException(status_code=500, detail="Failed to encode image")
            
        return Response(content=buffer.tobytes(), media_type="image/jpeg")

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
