import express from 'express';

export const router = express.Router();

const workOrders = [
  { id: 'wo-100', title: 'Packaging Line Calibration', priority: 'high', status: 'open' },
  { id: 'wo-101', title: 'Cold Storage Inspection', priority: 'medium', status: 'scheduled' }
];

router.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'fulfillment-api' });
});

router.get('/api/work-orders', (_req, res) => {
  res.json({ workOrders });
});

router.post('/api/work-orders', (req, res) => {
  if (!req.body?.title || !req.body?.priority) {
    return res.status(400).json({ error: 'title and priority are required' });
  }
  return res.status(201).json({
    workOrder: {
      id: 'wo-102',
      title: req.body.title,
      priority: req.body.priority,
      status: 'open'
    }
  });
});

router.delete('/api/work-orders/:id', (req, res) => {
  res.json({ id: req.params.id, status: 'deleted' });
});
