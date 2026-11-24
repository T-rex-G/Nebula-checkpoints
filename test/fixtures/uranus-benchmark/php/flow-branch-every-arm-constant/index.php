<?php
$conn = mysqli_connect('localhost', 'app', getenv('DB_PASSWORD'), 'app');
$order = $_GET['order'];
if ($order === 'desc') {
    $order = 'DESC';
} elseif ($order === 'name') {
    $order = 'NAME';
} else {
    $order = 'ASC';
}
$result = mysqli_query($conn, 'SELECT * FROM items ORDER BY name ' . $order);
