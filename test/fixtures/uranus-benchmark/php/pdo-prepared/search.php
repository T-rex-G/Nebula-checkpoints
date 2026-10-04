<?php
$pdo = new PDO(getenv('DATABASE_DSN'));
$statement = $pdo->prepare('SELECT * FROM products WHERE name LIKE ?');
$statement->execute(['%' . $_GET['q'] . '%']);
