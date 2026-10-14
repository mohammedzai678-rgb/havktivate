import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import VoiceAgentPage from './pages/VoiceAgentPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <VoiceAgentPage />
  </StrictMode>,
);
