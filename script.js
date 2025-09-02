// FAQ toggle function
function toggleFaq(button) {
    const faqItem = button.parentElement;
    const isActive = faqItem.classList.contains('active');
    // Close all FAQ items
    document.querySelectorAll('.faq-item').forEach(item => {
        item.classList.remove('active');
    });
    // If this item wasn't active, open it
    if (!isActive) {
        faqItem.classList.add('active');
    }
}

// Case Study Accordion toggle function
function toggleCaseStudyAccordion(button) {
    const caseStudyItem = button.parentElement;
    const isActive = caseStudyItem.classList.contains('active');
    // Close all other case study items
    document.querySelectorAll('.case-studies-accordion .case-study-item').forEach(item => {
        if (item !== caseStudyItem) {
            item.classList.remove('active');
        }
    });
    // Toggle the clicked item
    caseStudyItem.classList.toggle('active');
}

// Case Study Sub-Accordion toggle function
function toggleCaseStudySubAccordion(button) {
    const subItem = button.parentElement;
    const isActive = subItem.classList.contains('active');
    // Close all sibling sub-items
    const parentContainer = subItem.parentElement;
    parentContainer.querySelectorAll('.case-study-sub-item').forEach(item => {
        if (item !== subItem) {
            item.classList.remove('active');
        }
    });
    // Toggle the clicked sub-item
    subItem.classList.toggle('active');
}

// Animation on scroll
document.addEventListener('DOMContentLoaded', function() {
    const testimonialCards = document.querySelectorAll('.testimonial-card, .testimonial-card-1, .testimonial-card-2, .testimonial-card-3');
    const serviceCards = document.querySelectorAll('[class^="service-card-"]');
    const caseStudyCards = document.querySelectorAll('.case-study-card-1, .case-study-card-2, .case-study-card-3');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                // Animate testimonials
                if (entry.target.classList.contains('testimonials-section')) {
                    const cards = entry.target.querySelectorAll('.testimonial-card-1, .testimonial-card-2, .testimonial-card-3');
                    cards.forEach((card, index) => {
                        setTimeout(() => {
                            card.classList.add('animate');
                        }, index * 200);
                    });
                }
                // Animate services
                else if (entry.target.classList.contains('services-section')) {
                    const cards = entry.target.querySelectorAll('[class^="service-card-"]');
                    cards.forEach((card) => {
                        card.classList.add('animate');
                    });
                }
                // Animate case studies
                else if (entry.target.classList.contains('case-studies-section')) {
                    const cards = entry.target.querySelectorAll('.case-study-card-1, .case-study-card-2, .case-study-card-3');
                    cards.forEach((card, index) => {
                        setTimeout(() => {
                            card.classList.add('animate');
                        }, index * 200);
                    });
                }
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });
    
    const testimonialsSection = document.querySelector('.testimonials-section');
    const servicesSection = document.querySelector('.services-section');
    const caseStudiesSection = document.querySelector('.case-studies-section');
    
    if (testimonialsSection) {
        observer.observe(testimonialsSection);
    }
    if (servicesSection) {
        observer.observe(servicesSection);
    }
    if (caseStudiesSection) {
        observer.observe(caseStudiesSection);
    }
    
    // Burger Menu functionality
    const burgerIcon = document.getElementById('burgerIcon');
    const mobileMenuItems = document.getElementById('mobileMenuItems');
    
    if (burgerIcon && mobileMenuItems) {
        burgerIcon.addEventListener('click', (event) => {
            event.stopPropagation(); 
            mobileMenuItems.classList.toggle('active');
        });
        
        mobileMenuItems.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', () => {
                mobileMenuItems.classList.remove('active');
            });
        });
        
        document.body.addEventListener('click', (event) => {
            if (mobileMenuItems.classList.contains('active') && 
                !mobileMenuItems.contains(event.target) && 
                !burgerIcon.contains(event.target)) {
                mobileMenuItems.classList.remove('active');
            }
        });
    }

    // Custom Slow Scroll
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            const targetElement = document.querySelector(targetId);

            if (targetElement) {
                const menuHeight = document.querySelector('.main-menu').offsetHeight;
                const targetPosition = targetElement.getBoundingClientRect().top + window.pageYOffset - menuHeight;
                const startPosition = window.pageYOffset;
                const distance = targetPosition - startPosition;
                let startTime = null;
                const duration = 1000;

                function animation(currentTime) {
                    if (startTime === null) startTime = currentTime;
                    const timeElapsed = currentTime - startTime;
                    const run = ease(timeElapsed, startPosition, distance, duration);
                    window.scrollTo(0, run);
                    if (timeElapsed < duration) requestAnimationFrame(animation);
                }

                function ease(t, b, c, d) {
                    t /= d / 2;
                    if (t < 1) return c / 2 * t * t + b;
                    t--;
                    return -c / 2 * (t * (t - 2) - 1) + b;
                }

                requestAnimationFrame(animation);
            }
        });
    });

    // --- REMOVED ADVANCED FORM HANDLING ---
    // The browser will now handle form submission and redirection.

});

// Modal functions
function openModal(modalId) {
    document.getElementById(modalId).style.display = 'block'; 
    document.body.style.overflow = 'hidden';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
    document.body.style.overflow = 'auto';
}

window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
}
