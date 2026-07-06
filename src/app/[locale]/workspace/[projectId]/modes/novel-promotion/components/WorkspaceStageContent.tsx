'use client'

import ConfigStage from './ConfigStage'
import ScriptStage from './ScriptStage'
import StoryboardStage from './StoryboardStage'
import VideoStageRoute from './VideoStageRoute'
import VoiceStageRoute from './VoiceStageRoute'
import FaceSwapStage from './face-swap/FaceSwapStage'
import { FrameEditorPage } from '@/features/frame-editor/FrameEditorPage'

interface WorkspaceStageContentProps {
  currentStage: string
}

export default function WorkspaceStageContent({
  currentStage,
}: WorkspaceStageContentProps) {
  return (
    <div key={currentStage} className="animate-page-enter">
      {currentStage === 'config' && <ConfigStage />}

      {(currentStage === 'script' || currentStage === 'assets') && <ScriptStage />}

      {currentStage === 'storyboard' && <StoryboardStage />}

      {currentStage === 'videos' && <VideoStageRoute />}

      {currentStage === 'editor' && <FrameEditorPage />}

      {currentStage === 'voice' && <VoiceStageRoute />}
      
      {currentStage === 'face-swap' && <FaceSwapStage initialEngine="chunk" />}
    </div>
  )
}
