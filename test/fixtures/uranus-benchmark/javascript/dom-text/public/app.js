const target = document.getElementById('greeting');
target.textContent = decodeURIComponent(location.hash.slice(1));
