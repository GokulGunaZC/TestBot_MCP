export function App() {
  return (
    <main>
      <h1>Pulseboard</h1>
      <form>
        <label>
          Title
          <input name="title" required />
        </label>
        <label>
          Status
          <select name="status" required>
            <option value="">Choose status</option>
            <option value="open">Open</option>
            <option value="done">Done</option>
          </select>
        </label>
        <button type="submit">Create card</button>
      </form>
    </main>
  );
}

