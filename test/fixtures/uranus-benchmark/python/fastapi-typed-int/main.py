from fastapi import FastAPI
from sqlalchemy import text
from .database import engine

app = FastAPI()

@app.get('/items/{item_id}')
def item(item_id: int):
    with engine.connect() as connection:
        return connection.execute(text("SELECT * FROM items WHERE id = :id"), {'id': item_id}).one()
