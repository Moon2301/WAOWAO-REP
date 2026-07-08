import numpy as np

def compute_flow_raft(img1: np.ndarray, img2: np.ndarray) -> np.ndarray:
    """
    Simulates Optical Flow computation using RAFT.
    In a real implementation, this would load the torchvision RAFT model,
    preprocess the images, run inference, and return the flow field.
    
    Args:
        img1 (np.ndarray): HxWxC image 1 (BGR from OpenCV)
        img2 (np.ndarray): HxWxC image 2 (BGR from OpenCV)
        
    Returns:
        np.ndarray: HxWx2 flow field (dx, dy for each pixel)
    """
    print(f"Computing flow for images of shape: {img1.shape} and {img2.shape}")
    
    # Check if dimensions match
    if img1.shape != img2.shape:
        raise ValueError("Images must have the same dimensions")
        
    h, w = img1.shape[:2]
    
    # TODO: Implement actual PyTorch RAFT inference here
    # from torchvision.models.optical_flow import raft_small, Raft_Small_Weights
    # model = raft_small(weights=Raft_Small_Weights.DEFAULT, progress=False).to('cuda')
    # model.eval()
    # ... tensor conversion ...
    # flow = model(t_img1, t_img2)[-1]
    # return flow[0].permute(1, 2, 0).cpu().numpy()
    
    # STUB: Return zero flow
    # Flow is 2 channels: dx, dy
    flow = np.zeros((h, w, 2), dtype=np.float32)
    return flow
