import requests
client_id = "9"
code = input(":")
client_secret = "vkNr4NiwJci5Ejhx87dsh9XANDVYoBHgdUxbbv3b"
url = 'http://127.0.0.1:1240/v1/oauth2/token'
data = {
    'client_id': client_id,
    'client_secret': client_secret,
    #'grant_type': 'authorization_code',
    'code': code,
    'redirect_uri': 'http://localhost:8000/callback'
}
headers = {
    "Content-Type": "application/x-www-form-urlencoded"
}
response = requests.post(url, data=data, headers=headers)

print(response.status_code)
print(response.json())