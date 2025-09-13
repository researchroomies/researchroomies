CREATE TABLE countries (
    id INTEGER NOT NULL PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE states (
    id INTEGER NOT NULL PRIMARY KEY,
    country_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE TABLE cities (
    id INTEGER NOT NULL PRIMARY KEY,
    country_id INTEGER,
    state_id INTEGER,
    name TEXT NOT NULL,
    FOREIGN KEY (country_id) REFERENCES countries(id),
    FOREIGN KEY (state_id) REFERENCES states(id)
);

CREATE TABLE users (
    id INTEGER NOT NULL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at INTEGER
);

CREATE TABLE conferences (
    id INTEGER NOT NULL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    location_address TEXT,
    city_id INTEGER,
    start_time INTEGER NOT NULL,
    stop_time INTEGER NOT NULL,
    description TEXT,
    created_at INTEGER,
    is_featured INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (city_id) REFERENCES cities(id)
);

CREATE TABLE posts (
    id INTEGER NOT NULL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    conference_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (conference_id) REFERENCES conferences(id)
);

CREATE TABLE flags (
    id INTEGER NOT NULL PRIMARY KEY,
    post_id INTEGER NOT NULL,
    reason TEXT,
    flagged_by TEXT,
    timestamp INTEGER,
    FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE TABLE tags (
    slug TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE conference_tags (
    tag_slug TEXT NOT NULL,
    conference_id INTEGER NOT NULL,
    PRIMARY KEY (tag_slug, conference_id),
    FOREIGN KEY (tag_slug) REFERENCES tags(slug),
    FOREIGN KEY (conference_id) REFERENCES conferences(id)
);

CREATE TABLE message (
    post_id NUMBER,
    sender_email STRING,
    recipient_email STRING,
    content STRING,
    timestamp NUMBER
);

CREATE TABLE Message_Object_Storage (
    message_logs BUCKET,
    post_id_inquirer_email_object_key STRING,
    message_content_schema STRING,
    put(message) PROCEDURE
);