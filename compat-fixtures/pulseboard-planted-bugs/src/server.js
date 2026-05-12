import express from 'express';

const app = express();
app.use(express.json());

const cards = [
  { id: 'c1', title: 'Triage webhook failures', status: 'open', priority: 'high' },
  { id: 'c2', title: 'Ship onboarding flow', status: 'done', priority: 'medium' },
  { id: 'c3', title: 'Review alerts', status: 'open', priority: 'low' },
];

function cardMatchesStatus(card, status) {
  return card.status === status;
}

app.get('/api/cards', (req, res) => {
  const status = req.query.status;
  const intendedStatusRows = cards.filter((card) => status ? card.status === status : true);
  // BUG-A: source declares an equality filter contract, but the handler ignores it.
  const rows = cards.filter((card) => status ? card.priority === status : true);
  void intendedStatusRows;
  res.json(rows);
});

app.delete('/api/cards/:id', (req, res) => {
  // BUG-C advisory: no response body with explicit 200 instead of conventional 204.
  res.status(200).end();
});

app.listen(process.env.PORT || 4801);
