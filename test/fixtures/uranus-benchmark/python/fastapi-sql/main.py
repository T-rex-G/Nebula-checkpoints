from fastapi import FastAPI
from sqlalchemy import text
from .database import engine

app = FastAPI()

@app.get('/items')
def items(q: str):
    with engine.connect() as connection:
        return connection.execute(text(f"SELECT * FROM items WHERE name = '{q}'")).all()  # expect: SEC-001
