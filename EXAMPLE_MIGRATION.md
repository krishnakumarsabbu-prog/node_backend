# Example Migration: Spring MVC to Spring Boot

This document shows a complete example of migrating a Spring MVC project to Spring Boot using Migration Mode.

## Initial Project Structure

```
myproject/
├── pom.xml
├── src/main/
│   ├── java/com/example/
│   │   ├── controller/UserController.java
│   │   ├── service/UserService.java
│   │   └── repository/UserRepository.java
│   ├── resources/
│   │   └── application.properties
│   └── webapp/
│       └── WEB-INF/
│           ├── web.xml
│           ├── applicationContext.xml
│           └── views/
└── ...
```

## Step 1: User Request

**User**: "Migrate this Spring MVC project to Spring Boot"

## Step 2: Project Analysis

The analyzer detects:

```typescript
{
  framework: "spring-mvc",
  buildTool: "maven",
  xmlConfigs: [
    "src/main/webapp/WEB-INF/web.xml",
    "src/main/webapp/WEB-INF/applicationContext.xml"
  ],
  controllers: [
    "src/main/java/com/example/controller/UserController.java"
  ],
  services: [
    "src/main/java/com/example/service/UserService.java"
  ],
  repositories: [
    "src/main/java/com/example/repository/UserRepository.java"
  ],
  configFiles: [
    "src/main/resources/application.properties"
  ]
}
```

## Step 3: Generated Migration Plan

```json
{
  "migrationType": "spring_mvc_to_spring_boot",
  "summary": {
    "filesToModify": 5,
    "filesToDelete": 2,
    "filesToCreate": 1
  },
  "tasks": [
    {
      "file": "pom.xml",
      "action": "modify",
      "description": "Replace spring-webmvc dependencies with spring-boot-starter-web, spring-boot-starter-data-jpa. Add spring-boot-maven-plugin. Update parent to spring-boot-starter-parent."
    },
    {
      "file": "src/main/webapp/WEB-INF/web.xml",
      "action": "delete",
      "description": "Spring Boot uses embedded Tomcat and does not require web.xml"
    },
    {
      "file": "src/main/webapp/WEB-INF/applicationContext.xml",
      "action": "delete",
      "description": "Spring Boot uses Java configuration and auto-configuration instead of XML"
    },
    {
      "file": "src/main/java/com/example/Application.java",
      "action": "create",
      "description": "Create Spring Boot main application class with @SpringBootApplication annotation and main method"
    },
    {
      "file": "src/main/java/com/example/controller/UserController.java",
      "action": "modify",
      "description": "Add @RestController annotation if returning JSON, ensure @RequestMapping paths are correct"
    },
    {
      "file": "src/main/java/com/example/service/UserService.java",
      "action": "modify",
      "description": "Ensure @Service annotation is present for component scanning"
    },
    {
      "file": "src/main/java/com/example/repository/UserRepository.java",
      "action": "modify",
      "description": "Convert to Spring Data JPA repository interface extending JpaRepository"
    },
    {
      "file": "src/main/resources/application.properties",
      "action": "modify",
      "description": "Add Spring Boot configuration properties: server.port, spring.datasource.*, spring.jpa.* properties"
    }
  ]
}
```

## Step 4: Frontend Display

The frontend would display this plan as:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Migration Plan: spring_mvc_to_spring_boot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Summary:
  📝 Files to modify: 5
  ➕ Files to create: 1
  ❌ Files to delete: 2

Tasks:

1. 📝 MODIFY: pom.xml
   Replace spring-webmvc dependencies with spring-boot-starter-web,
   spring-boot-starter-data-jpa. Add spring-boot-maven-plugin.
   Update parent to spring-boot-starter-parent.

2. ❌ DELETE: src/main/webapp/WEB-INF/web.xml
   Spring Boot uses embedded Tomcat and does not require web.xml

3. ❌ DELETE: src/main/webapp/WEB-INF/applicationContext.xml
   Spring Boot uses Java configuration and auto-configuration
   instead of XML

4. ➕ CREATE: src/main/java/com/example/Application.java
   Create Spring Boot main application class with
   @SpringBootApplication annotation and main method

5. 📝 MODIFY: src/main/java/com/example/controller/UserController.java
   Add @RestController annotation if returning JSON, ensure
   @RequestMapping paths are correct

6. 📝 MODIFY: src/main/java/com/example/service/UserService.java
   Ensure @Service annotation is present for component scanning

7. 📝 MODIFY: src/main/java/com/example/repository/UserRepository.java
   Convert to Spring Data JPA repository interface extending
   JpaRepository

8. 📝 MODIFY: src/main/resources/application.properties
   Add Spring Boot configuration properties: server.port,
   spring.datasource.*, spring.jpa.* properties

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Cancel]  [Implement Migration]
```

## Step 5: User Clicks "Implement"

Frontend sends:

```json
{
  "chatMode": "migrate",
  "migrationAction": "implement",
  "migrationPlan": { /* plan from above */ },
  "files": { /* all project files */ }
}
```

## Step 6: Execution Results

Backend returns:

```json
{
  "filesModified": 5,
  "filesCreated": 1,
  "filesDeleted": 2,
  "modifiedFiles": {
    "pom.xml": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<project>\n  <parent>\n    <groupId>org.springframework.boot</groupId>\n    <artifactId>spring-boot-starter-parent</artifactId>\n    <version>3.2.0</version>\n  </parent>\n  ...",

    "src/main/java/com/example/controller/UserController.java": "package com.example.controller;\n\nimport org.springframework.web.bind.annotation.*;\n...",

    "src/main/java/com/example/service/UserService.java": "package com.example.service;\n\nimport org.springframework.stereotype.Service;\n...",

    "src/main/java/com/example/repository/UserRepository.java": "package com.example.repository;\n\nimport org.springframework.data.jpa.repository.JpaRepository;\n...",

    "src/main/resources/application.properties": "server.port=8080\nspring.datasource.url=jdbc:mysql://localhost:3306/mydb\n..."
  },
  "createdFiles": {
    "src/main/java/com/example/Application.java": "package com.example;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class Application {\n    public static void main(String[] args) {\n        SpringApplication.run(Application.class, args);\n    }\n}"
  },
  "deletedFiles": [
    "src/main/webapp/WEB-INF/web.xml",
    "src/main/webapp/WEB-INF/applicationContext.xml"
  ]
}
```

## Step 7: Frontend Updates

The frontend:
1. Applies all file changes to the virtual filesystem
2. Removes deleted files
3. Adds created files
4. Shows success notification
5. Updates file tree view

## Final Project Structure

```
myproject/
├── pom.xml (modified)
├── src/main/
│   ├── java/com/example/
│   │   ├── Application.java (new)
│   │   ├── controller/UserController.java (modified)
│   │   ├── service/UserService.java (modified)
│   │   └── repository/UserRepository.java (modified)
│   ├── resources/
│   │   └── application.properties (modified)
│   └── webapp/
│       └── WEB-INF/
│           └── views/
└── ...
```

## Example File Changes

### Before: pom.xml

```xml
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-webmvc</artifactId>
      <version>5.3.0</version>
    </dependency>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-jdbc</artifactId>
      <version>5.3.0</version>
    </dependency>
  </dependencies>
</project>
```

### After: pom.xml

```xml
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>

  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
```

### Before: UserRepository.java

```java
package com.example.repository;

import org.springframework.jdbc.core.JdbcTemplate;

public class UserRepository {
    private JdbcTemplate jdbcTemplate;

    public void setJdbcTemplate(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public User findById(Long id) {
        return jdbcTemplate.queryForObject(
            "SELECT * FROM users WHERE id = ?",
            new UserRowMapper(),
            id
        );
    }
}
```

### After: UserRepository.java

```java
package com.example.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface UserRepository extends JpaRepository<User, Long> {
    // Spring Data JPA provides findById automatically
}
```

### New: Application.java

```java
package com.example;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

## Benefits of This Approach

1. **Transparent**: User sees exactly what will change before execution
2. **Safe**: No surprises, explicit approval required
3. **Structured**: Clear task list, not raw code dumps
4. **Trackable**: Progress updates at each step
5. **Reversible**: Frontend can implement undo functionality
6. **Efficient**: LLM generates only necessary changes

## Frontend Implementation Notes

The frontend needs to:

1. Show migration plan in readable format
2. Allow users to review each task
3. Provide clear approval mechanism
4. Display execution progress
5. Apply file changes to virtual filesystem
6. Show diff view for modified files
7. Highlight created/deleted files

This creates a professional, trustworthy migration experience.
