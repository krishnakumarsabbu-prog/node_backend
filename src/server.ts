
import express from 'express';
import cors from 'cors';
import { chatHandler } from './routes/chat';
import { enhancerHandler } from './routes/enhancer';
import { llmCallHandler } from './routes/llmcall';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.post('/api/chat', chatHandler);
app.post("/api/enhancher", enhancerHandler);
app.post("/api/llmcall", llmCallHandler);

app.listen(8999, () => {
  console.log('Gateway running at http://localhost:8999');
});
